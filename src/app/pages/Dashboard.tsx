import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Package, FolderTree, DollarSign, TrendingUp } from 'lucide-react';

interface Stats {
  totalProducts: number;
  totalCategories: number;
  posMode: string;
}

export function Dashboard() {
  const { accessToken } = useAuth();
  const [stats, setStats] = useState<Stats>({
    totalProducts: 0,
    totalCategories: 0,
    posMode: 'table',
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      // Fetch products
      const productsRes = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-81f0b18a/products`,
        {
          headers: {
            'Authorization': `Bearer ${publicAnonKey}`,
          },
        }
      );
      const productsData = await productsRes.json();

      // Fetch categories
      const categoriesRes = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-81f0b18a/categories`,
        {
          headers: {
            'Authorization': `Bearer ${publicAnonKey}`,
          },
        }
      );
      const categoriesData = await categoriesRes.json();

      // Fetch settings
      const settingsRes = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-81f0b18a/settings`,
        {
          headers: {
            'Authorization': `Bearer ${publicAnonKey}`,
          },
        }
      );
      const settingsData = await settingsRes.json();

      setStats({
        totalProducts: productsData.products?.length || 0,
        totalCategories: categoriesData.categories?.length || 0,
        posMode: settingsData.settings?.mode || 'table',
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    {
      title: 'Total Products',
      value: stats.totalProducts,
      icon: Package,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
      link: '/dashboard/products',
    },
    {
      title: 'Categories',
      value: stats.totalCategories,
      icon: FolderTree,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      link: '/dashboard/categories',
    },
    {
      title: 'POS Mode',
      value: stats.posMode === 'table' ? 'Table-Based' : 'Barcode',
      icon: TrendingUp,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
      link: '/dashboard/settings',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

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
                  <CardTitle className="text-sm font-medium text-gray-600">
                    {stat.title}
                  </CardTitle>
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
              <p className="text-sm text-gray-600">Add, edit, or remove products from your inventory</p>
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
              <p className="text-sm text-gray-600">Configure your POS mode and preferences</p>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
