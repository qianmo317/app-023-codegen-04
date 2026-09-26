// 整台播放：多速度时间轴（每段/过渡各自 bpm）的 AudioContext 调度。
// 复用 audio.ts 的 lookahead 调度器与合成音，事件来自 computeProgramEvents。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument, ProgramTimeline, ScheduleEvent } from '../types';
import { scheduleEvents, type SchedulerHandle } from '../lib/audio';
import { computeProgramEvents } from '../lib/program';

export function useProgramAudio(timeline: ProgramTimeline, instruments: Instrument[]) {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const handleRef = useRef<SchedulerHandle | null>(null);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const instrumentsRef = useRef(instruments);
  instrumentsRef.current = instruments;
  const [playing, setPlaying] = useState(false);
  /** 当前播放到的整台小节号（1 起）与所在块序 */
  const [position, setPosition] = useState<{ globalBar: number; blockIndex: number } | null>(null);

  const ensureCtx = useCallback((): { ctx: AudioContext; master: GainNode } => {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterRef.current = master;
      (window as unknown as { __programAudioCtx?: AudioContext }).__programAudioCtx = ctx;
    }
    return { ctx: ctxRef.current, master: masterRef.current! };
  }, []);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setPlaying(false);
    setPosition(null);
  }, []);

  const play = useCallback(() => {
    handleRef.current?.stop();
    const { ctx, master } = ensureCtx();
    void ctx
      .resume()
      .catch(() => undefined)
      .then(() => {
        const tl = timelineRef.current;
        const insts = instrumentsRef.current;
        const startAt = ctx.currentTime + 0.08;
        const events = computeProgramEvents(tl, insts, startAt);
        // 整台小节号 → 所在块（高亮用）
        const barToBlock = new Map<number, number>();
        tl.blocks.forEach((b, bi) => {
          for (let barNo = b.fromBar; barNo <= b.toBar; barNo++) barToBlock.set(barNo, bi);
        });
        const visual = (ev: ScheduleEvent) => {
          setPosition({ globalBar: ev.barIndex + 1, blockIndex: barToBlock.get(ev.barIndex + 1) ?? -1 });
        };
        const handle = scheduleEvents(ctx, master, insts, events, visual);
        handleRef.current = handle;
        setPlaying(true);
        // 调试钩子：E2E 断言整台多速度调度
        (window as unknown as { __programScheduled?: () => ScheduleEvent[] }).__programScheduled = () =>
          handle.scheduled();
        const durS = tl.totalDurationS + 0.3;
        window.setTimeout(() => {
          if (handleRef.current === handle) stop();
        }, durS * 1000);
      });
  }, [ensureCtx, stop]);

  useEffect(() => () => handleRef.current?.stop(), []);

  return { playing, position, play, stop, ensureCtx };
}
