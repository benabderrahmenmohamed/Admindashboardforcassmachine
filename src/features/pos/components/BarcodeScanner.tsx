import { Barcode as BarcodeIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface BarcodeScannerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called on Enter (a scanner sends one after the code) and on the button. */
  readonly onSubmit: () => void;
}

export function BarcodeScanner({ value, onChange, onSubmit }: BarcodeScannerProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex gap-2">
          <Input
            placeholder="Scan or enter barcode..."
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // keypress never fired while an input method was composing; keep it that way.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                onSubmit();
              }
            }}
            className="text-lg"
          />
          <Button onClick={() => onSubmit()}>
            <BarcodeIcon className="w-5 h-5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
