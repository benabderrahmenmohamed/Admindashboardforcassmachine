import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { createClient } from '@supabase/supabase-js';
import { edgeFunctionUrl, env } from '../../lib/env';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  accessToken: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  signup: (email: string, password: string, name: string) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();
        if (session && !error) {
          setAccessToken(session.access_token);
          const userData = {
            id: session.user.id,
            email: session.user.email || '',
            name: (session.user.user_metadata?.name as string | undefined) || '',
            role: (session.user.app_metadata?.role as string | undefined) || 'worker',
          };
          setUser(userData);
        }
      } catch (error) {
        console.error('Error checking session:', error);
      } finally {
        setLoading(false);
      }
    };

    // Check for existing session
    void checkSession();
  }, []);

  const login = async (email: string, password: string): Promise<User> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw new Error(error.message);
      }

      if (data.session) {
        setAccessToken(data.session.access_token);
        const userData = {
          id: data.user.id,
          email: data.user.email || '',
          name: (data.user.user_metadata?.name as string | undefined) || '',
          role: (data.user.app_metadata?.role as string | undefined) || 'worker',
        };
        setUser(userData);
        return userData;
      }
      throw new Error('No session data');
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  };

  const signup = async (email: string, password: string, name: string): Promise<User> => {
    try {
      const response = await fetch(`${edgeFunctionUrl}/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.supabaseAnonKey}`,
        },
        body: JSON.stringify({ email, password, name }),
      });

      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error || 'Signup failed');
      }

      // After signup, log the user in
      return await login(email, password);
    } catch (error) {
      console.error('Signup error:', error);
      throw error;
    }
  };

  const logout = async () => {
    try {
      await supabase.auth.signOut();
      setUser(null);
      setAccessToken(null);
    } catch (error) {
      console.error('Logout error:', error);
      throw error;
    }
  };

  return (
    <AuthContext.Provider value={{ user, accessToken, loading, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
