// 排台 #/medley —— 把选中的几段按顺序接成一台：接缝补过渡小节、按各自速度算时间线、
// 可调顺序 / 临时抽掉再放回 / 整台生成试听，听完可退回没排之前的样子（合成谱只在内存，不落库）。
import { useEffect, useMemo, useState } from 'react';
import type { Medley as MedleyRec, Score } from '../types';
import { listScores, loadMedley, saveMedley } from '../lib/storage';
import {
  composeMedley,
  computeMedleyTimeline,
  emptyMedley,
  medleyAdd,
  medleyMove,
  medleyRemove,
  medleyRestore,
  segmentOf,
  type MedleyPart,
} from '../lib/medley';
import { useAudio } from '../hooks/useAudio';

function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m} 分 ${s.toFixed(1)} 秒` : `${s.toFixed(1)} 秒`;
}

/** 整台试听条：合成谱只在内存中播放，退回即丢弃，不写曲目列表 */
function AuditionPlayer({
  score,
  parts,
  onPos,
  onClose,
}: {
  score: Score;
  parts: MedleyPart[];
  onPos: (bar: number | null) => void;
  onClose: () => void;
}) {
  const audio = useAudio(score);
  useEffect(() => {
    onPos(audio.position ? audio.position.bar : null);
  }, [audio.position, onPos]);
  useEffect(() => () => audio.stop(), []); // 卸载（退回）时停声
  const cur =
    audio.position == null
      ? null
      : (parts.find((p) => audio.position!.bar >= p.fromBar - 1 && audio.position!.bar <= p.toBar - 1) ?? null);
  return (
    <div className="transport" data-testid="audition-player">
      <button className="btn primary" data-testid="btn-audition-play" onClick={() => (audio.playing ? audio.stop() : audio.play())}>
        {audio.playing ? '■ 停止' : '▶ 试听整台'}
      </button>
      <span className="pos" data-testid="audition-pos">
        {audio.position ? `第 ${audio.position.bar + 1} 小节` : '—'}
      </span>
      <span className="dim" data-testid="audition-part">
        {cur ? `正在播：${cur.title}` : ''}
      </span>
      <button
        className="btn"
        data-testid="btn-audition-close"
        onClick={() => {
          audio.stop();
          onClose();
        }}
      >
        退回（放弃合成）
      </button>
    </div>
  );
}

export function Medley() {
  const [scores, setScores] = useState<Score[]>([]);
  const [medley, setMedley] = useState<MedleyRec | null>(null);
  const [audition, setAudition] = useState<{ score: Score; parts: MedleyPart[] } | null>(null);
  const [audBar, setAudBar] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      const [ss, m] = await Promise.all([listScores(), loadMedley()]);
      setScores(ss);
      setMedley(m ?? emptyMedley());
    })();
  }, []);

  const closeAudition = () => {
    setAudition(null);
    setAudBar(null);
  };

  const update = (m: MedleyRec) => {
    setMedley(m);
    void saveMedley(m);
    closeAudition(); // 排法一变，已生成的试听作废，时间线跟着重算
  };

  const byId = useMemo(() => new Map(scores.map((s) => [s.id, s])), [scores]);
  // 曲目可能已被删除：解析时过滤，但不擅自改写排台记录
  const segments = useMemo(
    () => (medley ? medley.items.map((id) => byId.get(id)).filter((s): s is Score => !!s) : []),
    [medley, byId],
  );
  const timeline = useMemo(() => computeMedleyTimeline(segments.map(segmentOf)), [segments]);
  const removedList = useMemo(
    () =>
      medley
        ? medley.removed
            .map((r) => ({ ...r, score: byId.get(r.scoreId) }))
            .filter((r): r is typeof r & { score: Score } => !!r.score)
        : [],
    [medley, byId],
  );
  const pool = useMemo(() => {
    if (!medley) return [];
    const used = new Set([...medley.items, ...medley.removed.map((r) => r.scoreId)]);
    return scores.filter((s) => !used.has(s.id));
  }, [scores, medley]);

  if (!medley) return <div className="page">加载中…</div>;

  const genAudition = () => {
    if (segments.length === 0) return;
    // 连时间线一起快照：试听这一刻的排法
    setAudition({
      score: composeMedley(`整台试听（${segments.map((s) => s.title).join('＋')}）`, segments),
      parts: timeline.parts,
    });
  };

  return (
    <div className="page" data-testid="medley-page">
      <h1>排台</h1>
      <p className="dim">
        把几段锣鼓按顺序接成一台。两段拍数不一样时，接缝自动补一小节过渡（用下一段的拍号与速度，只留强拍的字，其余休止）；每段的起止时间按各自速度计算。
      </p>

      <div className="medley-cols">
        <div className="medley-pool">
          <h2>备选段</h2>
          {pool.length === 0 ? (
            <p className="dim">{scores.length === 0 ? '还没有曲目，先去「曲目」页新建或从曲牌库载入。' : '所有曲目都已在台里。'}</p>
          ) : (
            <table className="list" data-testid="medley-pool">
              <tbody>
                {pool.map((s) => (
                  <tr key={s.id} data-testid={`pool-row-${s.id}`}>
                    <td>{s.title}</td>
                    <td className="dim">
                      {s.freeMeter ? '散板' : `${s.bars[0]?.beatsPerBar ?? 4}/4`} · {s.bars.length} 小节 · {s.bpm}
                    </td>
                    <td>
                      <button className="mini" data-testid={`add-${s.id}`} onClick={() => update(medleyAdd(medley, s.id))}>
                        加入
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {removedList.length > 0 && (
            <>
              <h2>已抽掉</h2>
              <table className="list" data-testid="medley-removed">
                <tbody>
                  {removedList.map((r) => (
                    <tr key={r.scoreId} data-testid={`removed-row-${r.scoreId}`}>
                      <td className="dim">{r.score.title}</td>
                      <td>
                        <button className="mini" data-testid={`restore-${r.scoreId}`} onClick={() => update(medleyRestore(medley, r.scoreId))}>
                          放回原位
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="medley-main">
          <h2>当前一台（{segments.length} 段）</h2>
          {segments.length === 0 ? (
            <p className="dim">台还是空的，从左边「加入」几段。</p>
          ) : (
            <>
              <table className="list" data-testid="medley-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>段</th>
                    <th>拍号</th>
                    <th>BPM</th>
                    <th>小节</th>
                    <th>第几小节起止</th>
                    <th>起止时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.parts.map((p, pi) => {
                    const playing = audBar != null && audBar >= p.fromBar - 1 && audBar <= p.toBar - 1;
                    if (p.kind === 'transition') {
                      return (
                        <tr key={`t-${pi}`} className={`transition-row${playing ? ' playing' : ''}`} data-testid={`transition-row-${pi}`}>
                          <td></td>
                          <td colSpan={4}>⌇ {p.title}</td>
                          <td>
                            第 {p.fromBar} 小节
                          </td>
                          <td>
                            {p.startSec.toFixed(1)}″–{p.endSec.toFixed(1)}″
                          </td>
                          <td></td>
                        </tr>
                      );
                    }
                    const idx = medley.items.indexOf(p.scoreId!);
                    return (
                      <tr key={p.scoreId} className={playing ? 'playing' : ''} data-testid={`medley-row-${p.scoreId}`}>
                        <td className="dim">{idx + 1}</td>
                        <td>{p.title}</td>
                        <td>{p.beatsPerBar}/4</td>
                        <td>{p.bpm}</td>
                        <td>{p.barCount}</td>
                        <td data-testid={`range-${p.scoreId}`}>
                          第 {p.fromBar}–{p.toBar} 小节
                        </td>
                        <td data-testid={`time-${p.scoreId}`}>
                          {p.startSec.toFixed(1)}″–{p.endSec.toFixed(1)}″
                        </td>
                        <td>
                          <button className="mini" data-testid={`up-${p.scoreId}`} disabled={idx <= 0} onClick={() => update(medleyMove(medley, idx, idx - 1))}>
                            上移
                          </button>
                          <button
                            className="mini"
                            data-testid={`down-${p.scoreId}`}
                            disabled={idx < 0 || idx >= medley.items.length - 1}
                            onClick={() => update(medleyMove(medley, idx, idx + 1))}
                          >
                            下移
                          </button>
                          <button className="mini" data-testid={`remove-${p.scoreId}`} onClick={() => update(medleyRemove(medley, idx))}>
                            抽掉
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="medley-total" data-testid="medley-total">
                全台共 {timeline.totalBars} 小节 · 总时长 {fmtSec(timeline.totalSec)}
              </p>
              <div className="create-box">
                {!audition ? (
                  <button className="btn primary" data-testid="btn-compose" onClick={genAudition}>
                    生成整台试听
                  </button>
                ) : (
                  <button className="btn" data-testid="btn-revert" onClick={closeAudition}>
                    退回没排之前
                  </button>
                )}
                <span className="dim">试听用合成谱只在内存里，退回即丢弃，不动各段原谱。</span>
              </div>
            </>
          )}
        </div>
      </div>

      {audition && <AuditionPlayer score={audition.score} parts={audition.parts} onPos={setAudBar} onClose={closeAudition} />}
    </div>
  );
}
