import { UtensilsCrossed } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { TableBoard } from '@/features/orders/components/TableBoard';

/**
 * The waiter's room: tap a table to open it. Everything else happens on the table's own screen, bar
 * the menu of the day, where a dish the kitchen has run out of is marked sold out.
 */
export function ServeurPage() {
  const navigate = useNavigate();
  return (
    <div className="p-3">
      <div className="mb-3 flex justify-end">
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/serveur/menu">
            <UtensilsCrossed className="h-4 w-4" />
            Menu of the day
          </Link>
        </Button>
      </div>
      <TableBoard onSelect={(tableId) => void navigate(`/serveur/table/${tableId}`)} />
    </div>
  );
}
