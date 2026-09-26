// 整台预览：按块（段 / 过渡小节）逐段渲染谱面，标注整台小节号、拍号、速度；
// 播放时高亮当前块与小节。多速度由 useProgramAudio 调度，本组件只负责呈现。
import { useEffect, useRef } from 'react';
import type { Instrument, ProgramTimeline, Score } from '../types';
import { ScoreGrid, type Selection } from './ScoreGrid';
import { formatSeconds } from '../lib/program';

interface AudioLike {
  playing: boolean;
  position: { globalBar: number; blockIndex: number } | null;
  play: () => void;
  stop: () => void;
}

interface Props {
  timeline: ProgramTimeline;
  instruments: Instrument[];
  audio: AudioLike;
  onRevert: () => void;
}

export function ProgramPreview({ timeline, instruments, audio, onRevert }: Props) {
  const activeBlock = audio.position?.blockIndex ?? -1;
  const playBarRef = useRef<HTMLDivElement | null>(null);

  // 播放时把当前块滚进视图
  useEffect(() => {
    if (audio.playing && playBarRef.current) {
      playBarRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [audio.playing, audio.position?.blockIndex]);

  return (
    <div className="prog-preview" data-testid="prog-preview">
      <div className="preview-banner">
        <span className="dim">
          整台已冻结生成：{timeline.totalBars} 小节 · {formatSeconds(timeline.totalDurationS)}。听完点「退回编排前」恢复编排前的样子。
        </span>
      </div>

      {timeline.blocks.map((block, bi) => {
        const scoreLike: Pick<Score, 'bars' | 'instruments' | 'bpm' | 'freeMeter'> = {
          bars: block.bars,
          instruments,
          bpm: block.bpm,
          freeMeter: false,
        };
        const isJoint = block.kind === 'transition';
        const localBar = audio.position && activeBlock === bi ? audio.position.globalBar - block.fromBar : null;
        const highlight: Selection | null = localBar != null ? { bar: localBar, tick: 0 } : null;
        return (
          <div
            key={`${block.kind}-${block.itemKey}-${bi}`}
            ref={activeBlock === bi ? playBarRef : undefined}
            className={`preview-block ${isJoint ? 'joint' : ''} ${activeBlock === bi ? 'playing' : ''}`}
            data-testid={`preview-block-${bi}`}
            data-kind={block.kind}
          >
            <div className="block-head">
              <span className="block-tag" data-testid={`block-tag-${bi}`}>
                {isJoint ? `过渡小节（${block.joint!.from}/4 接 ${block.joint!.to}/4）` : `第 ${bi + 1} 段`}
              </span>
              <b>{block.title}</b>
              <span className="dim">
                {block.bars[0]?.beatsPerBar ?? 4}/4 · {block.bpm} BPM · 整台第 {block.fromBar}–{block.toBar} 小节 ·{' '}
                {formatSeconds(block.startS)} 起
              </span>
            </div>
            <div className="preview-grid-scroll">
              <ScoreGrid
                score={scoreLike as Score}
                pxPerTick={12}
                barsPerRow={8}
                highlight={highlight}
                showBeatHighlightBg={activeBlock === bi}
                testIdPrefix={`proggrid-${bi}`}
              />
            </div>
          </div>
        );
      })}

      <div className="preview-foot">
        <button className="btn danger-outline" data-testid="btn-revert-foot" onClick={onRevert}>
          退回编排前
        </button>
      </div>
    </div>
  );
}
