import { useEffect } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './ui/button';
import { Home, Package, FolderTree, Settings as SettingsIcon, LogOut, Menu } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from './ui/sheet';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: Home },
  { path: '/dashboard/products', label: 'Products', icon: Package },
  { path: '/dashboard/categories', label: 'Categories', icon: FolderTree },
  { path: '/dashboard/settings', label: 'Settings', icon: SettingsIcon },
];

function NavLinks({ pathname, mobile = false }: { pathname: string; mobile?: boolean }) {
  return (
    <nav className={mobile ? 'flex flex-col space-y-2' : 'space-y-1'}>
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = pathname === item.path;
        return (
          <Link
            key={item.path}
            to={item.path}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              isActive ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span className="font-medium">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function DashboardLayout() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) {
      void navigate('/');
    }
    // Redirect workers to POS
    if (!loading && user && user.role === 'worker') {
      void navigate('/pos');
    }
  }, [user, loading, navigate]);

  const handleLogout = async () => {
    await logout();
    void navigate('/');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile Header */}
      <div className="lg:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">POS System</h1>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72">
            <div className="mt-8">
              <div className="mb-6 pb-6 border-b">
                <p className="text-sm text-gray-500">Logged in as</p>
                <p className="font-semibold text-gray-900">{user.name}</p>
                <p className="text-sm text-gray-500">{user.email}</p>
                <span className="inline-block mt-2 px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">
                  {user.role}
                </span>
              </div>
              <NavLinks pathname={location.pathname} mobile />
              <Button variant="outline" className="w-full mt-6" onClick={() => void handleLogout()}>
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <div className="lg:flex">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block w-72 bg-white border-r border-gray-200 min-h-screen">
          <div className="p-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-8">POS System</h1>

            {/* User Info */}
            <div className="mb-8 pb-6 border-b border-gray-200">
              <p className="text-sm text-gray-500">Logged in as</p>
              <p className="font-semibold text-gray-900">{user.name}</p>
              <p className="text-sm text-gray-500">{user.email}</p>
              <span className="inline-block mt-2 px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded-full">
                {user.role}
              </span>
            </div>

            <NavLinks pathname={location.pathname} />

            <div className="mt-8 pt-6 border-t border-gray-200">
              <Button variant="outline" className="w-full" onClick={() => void handleLogout()}>
                <LogOut className="mr-2 h-4 w-4" />
                Logout
              </Button>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
