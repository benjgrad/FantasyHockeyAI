import { IosInstallHint } from './IosInstallHint';
import { StaleDataBanner } from './OfflineStatus';
import { UpdateBanner } from './UpdateBanner';

/** Everything the PWA layer shows under the header; each part renders nothing when idle. */
export function PwaBanners() {
  return (
    <>
      <UpdateBanner />
      <StaleDataBanner />
      <IosInstallHint />
    </>
  );
}
