import { NavLink } from 'react-router-dom';

/** "My team | League" at the top of the Team tab: the League view lives inside Team, not in the nav. */
export function TeamSwitch() {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex-1 rounded-md px-3 py-1.5 text-center text-sm ${
      isActive ? 'bg-raised font-medium text-ink' : 'text-mut hover:text-ink'
    }`;
  return (
    <nav className="flex gap-1 rounded-lg border border-line bg-well p-1" aria-label="Team views">
      <NavLink to="/team" end className={tab}>
        My team
      </NavLink>
      <NavLink to="/league" className={tab}>
        League
      </NavLink>
    </nav>
  );
}
