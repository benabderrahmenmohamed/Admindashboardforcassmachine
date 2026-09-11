import { FolderTree, Package, TrendingUp } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { useProducts } from '@/features/products/hooks/useProducts';
import type { StatCard } from '../types';

export function DashboardPage() {
  const products = useProducts();
  const categories = useCategories();

  // A failed refresh keeps the last counts on screen, so it is only logged, as the old page did.
  useEffect(() => {
    if (products.isRefetchError) console.error('Error fetching stats:', products.error);
  }, [products.isRefetchError, products.error]);

  useEffect(() => {
    if (categories.isRefetchError) console.error('Error fetching stats:', categories.error);
  }, [categories.isRefetchError, categories.error]);

  if (products.isPending || categories.isPending) {
    return <LoadingState />;
  }

  // Only a failed first load replaces the page. A retry puts such a query back to pending, so the
  // spinner shows while it runs.
  if (products.isLoadingError || categories.isLoadingError) {
    // Retry every failed query at once, so one click is enough when both failed.
    const retryFailed = () => {
      if (products.isError) void products.refetch();
      if (categories.isError) void categories.refetch();
    };
    return (
      <ErrorState
        error={products.isLoadingError ? products.error : categories.error}
        onRetry={retryFailed}
      />
    );
  }

  const statCards: StatCard[] = [
    {
      title: 'Total Products',
      value: products.data.length,
      icon: Package,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
      link: '/dashboard/products',
    },
    {
      title: 'Categories',
      value: categories.data.length,
      icon: FolderTree,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      link: '/dashboard/categories',
    },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Dashboard</h1>
        <p className="text-gray-600">Welcome to your POS admin panel</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link key={stat.title} to={stat.link}>
              <Card className="hover:shadow-lg transition-shadow cursor-pointer">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-gray-600">{stat.title}</CardTitle>
                  <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                    <Icon className={`w-5 h-5 ${stat.color}`} />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold text-gray-900">{stat.value}</div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link
              to="/dashboard/products"
              className="p-4 border border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
            >
              <Package className="w-8 h-8 text-blue-600 mb-2" />
              <h3 className="font-semibold text-gray-900 mb-1">Manage Products</h3>
              <p className="text-sm text-gray-600">
                Add, edit, or remove products from your inventory
              </p>
            </Link>
            <Link
              to="/dashboard/categories"
              className="p-4 border border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition-colors"
            >
              <FolderTree className="w-8 h-8 text-green-600 mb-2" />
              <h3 className="font-semibold text-gray-900 mb-1">Manage Categories</h3>
              <p className="text-sm text-gray-600">Organize your products with categories</p>
            </Link>
            <Link
              to="/dashboard/settings"
              className="p-4 border border-gray-200 rounded-lg hover:border-purple-500 hover:bg-purple-50 transition-colors"
            >
              <TrendingUp className="w-8 h-8 text-purple-600 mb-2" />
              <h3 className="font-semibold text-gray-900 mb-1">POS Settings</h3>
              <p className="text-sm text-gray-600">Configure the receipt footer</p>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
