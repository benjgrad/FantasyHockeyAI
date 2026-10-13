export function Toggle({
  on,
  onChange,
  label,
  tone = 'good',
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  tone?: 'good' | 'warn' | 'bad';
  disabled?: boolean;
}) {
  const bg = on ? { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad' }[tone] : 'bg-line';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 ${bg}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-knob shadow-sm transition-transform ${on ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}
