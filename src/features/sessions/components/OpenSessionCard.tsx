import { LockOpen } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readCashAmount } from '@/features/pos/selling';
import type { Millimes } from '@/lib/money';

interface OpenSessionCardProps {
  readonly terminalCode: string;
  /** True while the opening is being written to this device. */
  readonly isOpening: boolean;
  readonly onOpen: (openingFloatMillimes: Millimes) => void;
}

export function OpenSessionCard({ terminalCode, isOpening, onOpen }: OpenSessionCardProps) {
  const [floatText, setFloatText] = useState('');
  // The problem is shown once the cashier has tried to open, then follows what they type.
  const [showProblem, setShowProblem] = useState(false);
  const openingFloat = readCashAmount(floatText);

  return (
    <div className="max-w-md mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LockOpen className="w-5 h-5" />
            Open a session
          </CardTitle>
          <CardDescription>
            Terminal {terminalCode} has no open session. Count the cash in the drawer and enter it
            as the opening float.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!openingFloat.ok) {
                setShowProblem(true);
              } else if (!isOpening) {
                onOpen(openingFloat.millimes);
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="opening-float">Opening float (DT)</Label>
              <Input
                id="opening-float"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.000"
                value={floatText}
                onChange={(e) => setFloatText(e.target.value)}
                aria-invalid={showProblem && !openingFloat.ok}
                className="text-lg"
              />
              {showProblem && !openingFloat.ok && (
                <p className="text-sm text-red-600">{openingFloat.problem}</p>
              )}
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={isOpening}>
              <LockOpen className="mr-2 h-4 w-4" />
              {isOpening ? 'Opening...' : 'Open session'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
