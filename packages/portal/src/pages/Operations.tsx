import { useState } from 'react';
import CustomerSupport from './CustomerSupport';
import NetworkOps from './NetworkOps';
import Notifications from './Notifications';
import { PageHeader, TabBar } from '../components/ui';

const TABS = [
  { id: 'incidents', label: 'Live Incidents' },
  { id: 'support', label: 'Driver Look Up' },
  { id: 'notifications', label: 'Notifications' },
];

export default function Operations() {
  const [tab, setTab] = useState('incidents');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Operations"
        description="Incident response, support workflows, and proactive notification operations."
      />

      <TabBar tabs={TABS} activeTab={tab} onChange={setTab} />

      {tab === 'incidents' && <NetworkOps />}
      {tab === 'support' && <CustomerSupport />}
      {tab === 'notifications' && <Notifications />}
    </div>
  );
}
