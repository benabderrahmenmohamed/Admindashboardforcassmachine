import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { toast } from 'sonner';
import { Settings as SettingsIcon, Utensils, Barcode, Save } from 'lucide-react';

interface POSSettings {
  mode: 'table' | 'barcode';
  currency: string;
  taxRate: number;
  receiptFooter: string;
}

export function Settings() {
  const { accessToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<POSSettings>({
    mode: 'table',
    currency: '$',
    taxRate: 0,
    receiptFooter: 'Thank you for your purchase!',
  });

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-81f0b18a/settings`,
        {
          headers: {
            'Authorization': `Bearer ${publicAnonKey}`,
          },
        }
      );
      const data = await response.json();
      if (response.ok && data.settings) {
        setSettings(data.settings);
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
      toast.error('Failed to fetch settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch(
        `https://${projectId}.supabase.co/functions/v1/make-server-81f0b18a/settings`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify(settings),
        }
      );

      const data = await response.json();

      if (response.ok) {
        toast.success('Settings saved successfully');
      } else {
        toast.error(data.error || 'Failed to save settings');
      }
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

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
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Settings</h1>
        <p className="text-gray-600">Configure your POS system preferences</p>
      </div>

      <div className="space-y-6">
        {/* POS Mode Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="w-5 h-5" />
              POS Mode
            </CardTitle>
            <CardDescription>
              Choose how your POS system operates based on your business type
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={settings.mode}
              onValueChange={(value: 'table' | 'barcode') =>
                setSettings({ ...settings, mode: value })
              }
              className="space-y-4"
            >
              <Card className={`cursor-pointer transition-all ${
                settings.mode === 'table' ? 'border-blue-600 border-2 bg-blue-50' : 'border-gray-200'
              }`}>
                <CardContent className="pt-6">
                  <div className="flex items-start gap-4">
                    <RadioGroupItem value="table" id="table" className="mt-1" />
                    <div className="flex-1">
                      <Label htmlFor="table" className="cursor-pointer">
                        <div className="flex items-center gap-2 mb-2">
                          <Utensils className="w-5 h-5 text-blue-600" />
                          <span className="font-semibold text-lg">Table-Based Mode</span>
                        </div>
                        <p className="text-sm text-gray-600">
                          Perfect for restaurants, cafes, and bars. Manage orders by table number,
                          split bills, and track dine-in service.
                        </p>
                        <div className="mt-3 space-y-1">
                          <p className="text-xs text-gray-500">✓ Table management</p>
                          <p className="text-xs text-gray-500">✓ Order tracking by table</p>
                          <p className="text-xs text-gray-500">✓ Split bill functionality</p>
                          <p className="text-xs text-gray-500">✓ Dine-in service workflow</p>
                        </div>
                      </Label>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className={`cursor-pointer transition-all ${
                settings.mode === 'barcode' ? 'border-blue-600 border-2 bg-blue-50' : 'border-gray-200'
              }`}>
                <CardContent className="pt-6">
                  <div className="flex items-start gap-4">
                    <RadioGroupItem value="barcode" id="barcode" className="mt-1" />
                    <div className="flex-1">
                      <Label htmlFor="barcode" className="cursor-pointer">
                        <div className="flex items-center gap-2 mb-2">
                          <Barcode className="w-5 h-5 text-purple-600" />
                          <span className="font-semibold text-lg">Barcode/Instant Mode</span>
                        </div>
                        <p className="text-sm text-gray-600">
                          Ideal for retail stores and supermarkets. Scan products, process quick
                          checkouts, and manage inventory efficiently.
                        </p>
                        <div className="mt-3 space-y-1">
                          <p className="text-xs text-gray-500">✓ Barcode scanning</p>
                          <p className="text-xs text-gray-500">✓ Quick checkout process</p>
                          <p className="text-xs text-gray-500">✓ Inventory tracking</p>
                          <p className="text-xs text-gray-500">✓ Fast transaction workflow</p>
                        </div>
                      </Label>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </RadioGroup>
          </CardContent>
        </Card>

        {/* Additional Settings */}
        <Card>
          <CardHeader>
            <CardTitle>General Settings</CardTitle>
            <CardDescription>Configure currency and tax settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currency">Currency Symbol</Label>
              <select
                id="currency"
                value={settings.currency}
                onChange={(e) => setSettings({ ...settings, currency: e.target.value })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="$">$ - US Dollar</option>
                <option value="€">€ - Euro</option>
                <option value="£">£ - British Pound</option>
                <option value="¥">¥ - Japanese Yen</option>
                <option value="₹">₹ - Indian Rupee</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="taxRate">Tax Rate (%)</Label>
              <input
                id="taxRate"
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={settings.taxRate}
                onChange={(e) => setSettings({ ...settings, taxRate: parseFloat(e.target.value) || 0 })}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="receiptFooter">Receipt Footer Message</Label>
              <textarea
                id="receiptFooter"
                value={settings.receiptFooter}
                onChange={(e) => setSettings({ ...settings, receiptFooter: e.target.value })}
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Thank you for your purchase!"
              />
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving} size="lg">
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
