import { Loader2, ShoppingCart } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBackend } from '@/lib/backend-context';
import { errorMessage } from '@/lib/errors';
import type { Credentials } from '@/ports';
import { useAuth } from '../hooks/useAuth';
import { homePathFor } from '../roles';

export function LoginPage() {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const { demoAccounts = [] } = useBackend();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const signInWith = async (credentials: Credentials) => {
    setLoading(true);
    try {
      const user = await signIn(credentials);
      toast.success('Login successful!');
      const home = homePathFor(user);
      if (home !== null) {
        void navigate(home);
      }
      // With no face for these roles the landing page stays put and says so.
    } catch (error) {
      toast.error(errorMessage(error, 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void signInWith({ email, password });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-blue-600 rounded-full">
              <ShoppingCart className="w-8 h-8 text-white" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold">POS System</CardTitle>
          <CardDescription>Flexible Point of Sale for All Businesses</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                placeholder="admin@example.com"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Logging in...
                </>
              ) : (
                'Login'
              )}
            </Button>
          </form>

          {demoAccounts.length > 0 && (
            <div className="border-t pt-4">
              <p className="text-xs text-gray-500 text-center mb-3">
                Demo accounts: sample data that resets when you reload
              </p>
              <div className="grid grid-cols-2 gap-2">
                {demoAccounts.map((account) => (
                  <Button
                    key={account.email}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={loading}
                    onClick={() =>
                      void signInWith({ email: account.email, password: account.password })
                    }
                  >
                    Continue as {account.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
