/** The only screen a signed-out visitor sees. Sign-in happens on Personal OS (OIDC). */
export function SignIn() {
  const returnTo = window.location.pathname + window.location.search;
  const href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <main className="grid min-h-full place-items-center p-4">
      <div className="card w-full max-w-sm text-center">
        <img src="/favicon.svg" alt="" className="mx-auto mb-3 size-20 rounded-2xl" />
        <h1 className="display text-4xl leading-none">
          Hockey <span className="text-brand-ink">GM</span>
        </h1>
        <p className="mt-1 mb-5 text-sm text-mut">
          Your Yahoo NHL fantasy team’s assistant — lineups, waivers, trades and approvals.
        </p>
        <a className="btn btn-primary w-full" href={href}>
          Sign in with Personal OS
        </a>
      </div>
    </main>
  );
}
