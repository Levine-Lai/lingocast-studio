import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "../types";

type Props = {
  style: SubtitleStyle;
  onChange: (patch: Partial<SubtitleStyle>) => void;
  onClose: () => void;
  applyToAll: boolean;
  canEditSingle: boolean;
  onApplyToAllChange: (checked: boolean) => void;
};

const FONT_OPTIONS = ["Arial", "Microsoft YaHei", "Segoe UI", "SimHei", "KaiTi"];

function RangeControl({ label, value, min, max, step = 1, suffix = "", onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="style-range">
      <span><span>{label}</span><span className="style-number"><input aria-label={`${label}数值`} type="number" min={min} max={max} step={step} value={Number(value.toFixed(step < 1 ? 2 : 0))} onChange={(event) => onChange(Number(event.target.value))} />{suffix}</span></span>
      <input aria-label={`${label}滑块`} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="style-color"><span>{label}</span><input type="color" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function SubtitleStylePanel({ style, onChange, onClose, applyToAll, canEditSingle, onApplyToAllChange }: Props) {
  return (
    <aside className="subtitle-style-panel" aria-label="字幕样式设置">
      <header><div><strong>字幕样式</strong><small>修改会同步用于烧录导出</small></div><button type="button" onClick={onClose} aria-label="关闭字幕样式">×</button></header>
      <div className="style-panel-scroll">
        <section className="style-scope">
          <label><input type="checkbox" checked={applyToAll} disabled={!canEditSingle} onChange={(event) => onApplyToAllChange(event.target.checked)} /><span><strong>全部修改</strong><small>{applyToAll ? "本次修改应用到所有字幕" : "当前只修改这一条字幕"}</small></span></label>
        </section>
        <section>
          <h3>英文字幕</h3>
          <div className="style-grid"><ColorControl label="颜色" value={style.sourceColor} onChange={(sourceColor) => onChange({ sourceColor })} /><label>字体<select value={style.sourceFontFamily} onChange={(event) => onChange({ sourceFontFamily: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font}>{font}</option>)}</select></label></div>
          <RangeControl label="字号" value={style.sourceFontSize} min={18} max={96} suffix=" px" onChange={(sourceFontSize) => onChange({ sourceFontSize })} />
        </section>
        <section>
          <h3>中文字幕</h3>
          <div className="style-grid"><ColorControl label="颜色" value={style.targetColor} onChange={(targetColor) => onChange({ targetColor })} /><label>字体<select value={style.targetFontFamily} onChange={(event) => onChange({ targetFontFamily: event.target.value })}>{FONT_OPTIONS.map((font) => <option key={font}>{font}</option>)}</select></label></div>
          <RangeControl label="字号" value={style.targetFontSize} min={18} max={96} suffix=" px" onChange={(targetFontSize) => onChange({ targetFontSize })} />
        </section>
        <section>
          <h3>文字效果</h3>
          <div className="style-checks"><label><input type="checkbox" checked={style.bold} onChange={(event) => onChange({ bold: event.target.checked })} />加粗</label><label><input type="checkbox" checked={style.shadow} onChange={(event) => onChange({ shadow: event.target.checked })} />阴影</label></div>
          <div className="style-grid"><ColorControl label="外框颜色" value={style.outlineColor} onChange={(outlineColor) => onChange({ outlineColor })} /><RangeControl label="外框" value={style.outlineWidth} min={0} max={8} step={0.5} suffix=" px" onChange={(outlineWidth) => onChange({ outlineWidth })} /></div>
          <RangeControl label="文字不透明度" value={style.textOpacity * 100} min={10} max={100} suffix="%" onChange={(value) => onChange({ textOpacity: value / 100 })} />
          <RangeControl label="行高" value={style.lineHeight} min={0.9} max={1.8} step={0.05} onChange={(lineHeight) => onChange({ lineHeight })} />
          <RangeControl label="中英间距" value={style.lineGap} min={0} max={36} suffix=" px" onChange={(lineGap) => onChange({ lineGap })} />
        </section>
        <section>
          <h3>背景框</h3>
          <label className="style-switch"><input type="checkbox" checked={style.backgroundEnabled} onChange={(event) => onChange({ backgroundEnabled: event.target.checked })} />显示背景框</label>
          <ColorControl label="背景颜色" value={style.backgroundColor} onChange={(backgroundColor) => onChange({ backgroundColor })} />
          <RangeControl label="背景不透明度" value={style.backgroundOpacity * 100} min={0} max={100} suffix="%" onChange={(value) => onChange({ backgroundOpacity: value / 100 })} />
        </section>
        <section>
          <h3>画面位置</h3>
          <RangeControl label="水平" value={style.positionX} min={3} max={97} suffix="%" onChange={(positionX) => onChange({ positionX })} />
          <RangeControl label="距底部" value={style.positionY} min={1} max={80} suffix="%" onChange={(positionY) => onChange({ positionY })} />
        </section>
      </div>
      <footer><button type="button" onClick={() => onChange({ ...DEFAULT_SUBTITLE_STYLE })}>恢复默认</button><button className="primary" type="button" onClick={onClose}>完成</button></footer>
    </aside>
  );
}
