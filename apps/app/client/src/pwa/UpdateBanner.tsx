import { useServiceWorkerUpdate } from './update';

/** "Update available — Reload": shown while a new build's worker waits (see update.ts). */
export function UpdateBanner() {
  const update = useServiceWorkerUpdate();
  if (!update.available) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-line bg-raised px-3 py-2 text-sm"
    >
      <span className="min-w-0 flex-1">Update available.</span>
      <button className="btn btn-primary btn-sm" onClick={update.apply}>
        Reload
      </button>
    </div>
  );
}
