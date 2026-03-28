import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '📊', exact: true },
  { to: '/calls', label: 'Calls', icon: '📞' },
  { to: '/leads', label: 'Leads', icon: '👤' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Sidebar */}
      <aside className="w-60 bg-brand-900 flex flex-col">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-brand-700">
          <h1 className="text-white text-xl font-bold tracking-tight">Aria</h1>
          <p className="text-brand-100 text-xs mt-0.5 opacity-70">Voice Agent Dashboard</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ to, label, icon, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand-700 text-white'
                    : 'text-brand-100 hover:bg-brand-800 hover:text-white'
                }`
              }
            >
              <span>{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div className="px-4 py-4 border-t border-brand-700">
          <p className="text-brand-100 text-xs truncate opacity-70">{user?.username}</p>
          <button
            onClick={() => logout()}
            className="mt-2 text-brand-100 text-xs hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
