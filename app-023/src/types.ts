// 数据模型 —— 与 README §7 保持一致（允许向后兼容扩展字段）

export type Tech = 'roll' | 'mute' | 'flam';
export type SynthType = 'drum' | 'metal' | 'wood';

export interface Synth {
  type: SynthType;
  baseHz: number;
  decay: number; // 秒
  noise: boolean;
}

export interface Instrument {
  id: string;
  name: string;
  glyphs: string[]; // 拟音字，如 ['咚','八']
  synth: Synth;
  /** 同一乐器不同拟音字 → 不同技法（反查表依据），如 { '八': ['flam'] } */
  techMap?: Record<string, Tech[]>;
  color?: string;
}

export interface Hit {
  instrumentId: string;
  velocity: 1 | 2 | 3; // 1=弱(p) 2=中(mf) 3=强(f)
  glyph?: string;
  tech?: Tech[];
}

export interface Step {
  beats: number; // 格数（每拍 4 格）：整拍 4、半拍 2、1/4 拍 1、附点 6、附点半拍 3
  hits: Hit[];
  tie?: boolean; // 与下一步连线（连打）
  rest?: boolean; // 休止
}

export interface Bar {
  index: number;
  beatsPerBar: number; // 每小节拍数（散板仍给默认 4）
  steps: Step[];
  tempoNote?: string; // 渐快/渐慢等文字标记
}

export interface Score {
  id: string;
  title: string;
  style?: string;
  bpm: number;
  bars: Bar[];
  instruments: Instrument[];
  freeMeter: boolean; // 散板
  updatedAt: number;
}

/** 键位绑定：键盘字符 → 某乐器的第几个拟音字 */
export interface KeyBinding {
  key: string; // 小写字母或符号
  instrumentId: string;
  glyphIndex: number;
}

export interface AppSettings {
  keyMap: KeyBinding[];
  durationKeys: Record<string, number>; // 数字键 → 格数
  showHighlight: boolean; // 试听时当前拍高亮（可关闭）
  currentBeatStretch: number; // 散板近似播放伸缩系数
}

/** 一个待调度的事件（音频/视觉共用） */
export interface ScheduleEvent {
  time: number; // AudioContext 时间轴上的绝对秒
  barIndex: number;
  offset: number; // 小节内格偏移
  instrumentId: string;
  hit: Hit;
  glyph: string;
  durationTicks: number;
}

// ---------- 整台编排（多段拼接 + 过渡小节） ----------

/** 台子里的一段：引用一个曲目 Score */
export interface ProgramItem {
  key: string; // 台内唯一 key（同曲可重复加入）
  scoreId: string;
  title: string; // 加入时的曲名快照（列表回退显示用）
  bpm: number; // 加入时的速度快照
  beatsPerBar: number; // 加入时的每小节拍数快照
  bars: number; // 加入时的小节数快照
  included: boolean; // false = 临时抽掉（保留位置，随时放回）
}

/** 一台锣鼓节目 */
export interface Program {
  id: string;
  title: string;
  items: ProgramItem[];
  updatedAt: number;
}

/** 解析后的段（关联上现存 Score；缺失时 missing） */
export interface ResolvedSegment {
  item: ProgramItem;
  score: Score | null; // null = 源曲目已删除（回退用快照）
  missing: boolean;
}

/** 整台时间轴上的一块：一段曲目，或一段接头过渡小节 */
export interface ProgramBlock {
  kind: 'segment' | 'transition';
  /** segment: 对应 item.key；transition: 后段 item.key */
  itemKey: string;
  title: string;
  bars: Bar[]; // 已按整台顺序重编 index
  bpm: number; // 本块速度（过渡小节用后段速度）
  barCount: number;
  fromBar: number; // 整台小节号（含过渡，1 起）
  toBar: number; // 含
  startS: number; // 整台时间轴上的起点（秒）
  endS: number; // 含尾
  durationS: number;
  /** 仅 transition：由哪段接到哪段的拍数说明 */
  joint?: { from: number; to: number };
}

/** 每一段（不含过渡）在整台里的占比信息 */
export interface SegmentTiming {
  key: string;
  title: string;
  bpm: number;
  beatsPerBar: number;
  ownBars: number; // 本段自身小节数
  fromBar: number; // 整台小节号（1 起；过渡小节不计入段范围）
  toBar: number; // 含
  startS: number;
  endS: number;
  durationS: number;
  missing: boolean;
  /** 本段之前是否插了过渡小节 */
  transitionBefore: boolean;
}

export interface ProgramTimeline {
  blocks: ProgramBlock[];
  segments: SegmentTiming[];
  totalBars: number;
  totalDurationS: number;
  missingKeys: string[]; // 参演但源曲目已缺失的段
}

export const TICKS_PER_BEAT = 4;
export const VELOCITY_GAIN: Record<Hit['velocity'], number> = { 1: 0.4, 2: 0.7, 3: 1.0 };
