import { Dashboard } from '../components/Dashboard';

// Static shell — the Dashboard is a client component that reads its
// own config (env defaults + localStorage overrides) and fetches
// directly from the viewer's browser. The Explorer server makes no
// outbound calls.
export default function Page() {
  return <Dashboard />;
}
