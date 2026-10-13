import { useTheme, type ThemeChoice } from '../theme/theme';

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Appearance: follow the phone's light/dark setting, or pin one. Applies at once. */
export function ThemeSettings() {
  const [choice, setChoice] = useTheme();
  return (
    <div className="card flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-well p-1"
      >
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={choice === o.value}
            onClick={() => setChoice(o.value)}
            className={`min-h-10 rounded-md text-sm transition focus-visible:outline-2 focus-visible:outline-brand ${
              choice === o.value
                ? 'bg-card font-semibold text-ink shadow-sm ring-1 ring-line'
                : 'text-mut hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-mut">
        System follows your phone’s light or dark setting. This is saved on this device only.
      </p>
    </div>
  );
}
