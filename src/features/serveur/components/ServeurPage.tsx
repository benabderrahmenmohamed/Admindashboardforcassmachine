import { useNavigate } from 'react-router';
import { TableBoard } from '@/features/orders/components/TableBoard';

/** The waiter's room: tap a table to open it. Everything else happens on the table's own screen. */
export function ServeurPage() {
  const navigate = useNavigate();
  return (
    <div className="p-3">
      <TableBoard onSelect={(tableId) => void navigate(`/serveur/table/${tableId}`)} />
    </div>
  );
}
