/** The only screen a signed-out visitor sees. Sign-in happens on Personal OS (OIDC). */
export function SignIn() {
  const returnTo = window.location.pathname + window.location.search;
  const href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <main className="grid min-h-full place-items-center p-4">
      <div className="card w-full max-w-sm text-center">
        <img src="/icon-192.png" alt="" className="mx-auto mb-3 h-16 w-16 rounded-2xl" />
        <h1 className="text-lg font-semibold">FantasyHockeyAI</h1>
        <p className="mt-1 mb-5 text-sm text-mut">
          Your Yahoo NHL fantasy team’s assistant — lineups, waivers, trades and approvals.
        </p>
        <a className="btn btn-primary w-full py-3" href={href}>
          Sign in with Personal OS
        </a>
      </div>
    </main>
  );
}
