import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Chip, Typography } from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch } from '../api';
import { notifyNotificationsChanged } from '../components/NotificationBell';
import { useAuth } from '../context/AuthContext';
import NotificationSettings from './NotificationSettings';

const POLL_MS = 45000;
const LIMIT = 20;

const typeLabels = {
  delivery_overdue: 'Overdue',
  delivery_due_soon: 'Due soon',
  work_order_on_hold: 'On hold',
  work_order_completed: 'Completed',
  work_order_rush: 'Rush',
};

function formatStamp(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 19);
}

export default function Notifications() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    function pull(showLoading) {
      if (showLoading) setLoading(true);
      authFetch(`/api/notifications?limit=${LIMIT}&offset=${offset}`, { cache: 'no-store' })
        .then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || 'Unable to load notifications');
          if (cancelled) return;
          setItems(body.notifications || []);
          setUnread(body.unread_count || 0);
          setTotal(body.total || 0);
          setError('');
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Unable to load notifications');
        })
        .finally(() => {
          if (!cancelled && showLoading) setLoading(false);
        });
    }

    pull(true);
    const timer = setInterval(() => pull(false), POLL_MS);
    const onChange = () => pull(false);
    window.addEventListener('notifications:changed', onChange);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('notifications:changed', onChange);
    };
  }, [offset]);

  async function markRead(item) {
    if (!item.read) {
      const response = await authFetch(`/api/notifications/${item.id}/read`, { method: 'POST', cache: 'no-store' });
      if (response.ok) notifyNotificationsChanged();
    }
    if (item.work_order_id) navigate(`/work-orders/${item.work_order_id}`);
  }

  async function markAllRead() {
    const response = await authFetch('/api/notifications/read-all', { method: 'POST', cache: 'no-store' });
    if (!response.ok) return;
    notifyNotificationsChanged();
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2 }}>
        <Box>
          <Typography variant="h4">Notifications</Typography>
          <Typography color="text.secondary">
            {unread} unread
          </Typography>
        </Box>
        <Button variant="outlined" disabled={unread < 1} onClick={markAllRead}>
          Mark all read
        </Button>
      </Box>

      {user?.role === 'admin' ? <NotificationSettings /> : null}

      {loading && items.length === 0 ? <LoadingState message="Loading notifications..." /> : null}
      {error ? <ErrorState message={error} /> : null}

      {!error && !loading && items.length === 0 ? (
        <SectionCard title="Nothing yet" subtitle="Delivery and work order alerts will show up here." />
      ) : null}

      {items.map((item) => (
        <SectionCard key={item.id} title={item.title} subtitle={formatStamp(item.created_at)}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'flex-start' }}>
            <Box>
              <Chip size="small" label={typeLabels[item.type] || item.type} sx={{ mb: 1 }} color={item.read ? 'default' : 'primary'} />
              <Typography>{item.body}</Typography>
            </Box>
            <Button size="small" onClick={() => markRead(item)}>
              {item.work_order_id ? 'Open' : item.read ? 'Read' : 'Mark read'}
            </Button>
          </Box>
        </SectionCard>
      ))}

      {total > LIMIT && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
          <Button disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
            Previous
          </Button>
          <Typography color="text.secondary" sx={{ alignSelf: 'center' }}>
            {offset + 1}–{Math.min(offset + items.length, total)} of {total}
          </Typography>
          <Button disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
            Next
          </Button>
        </Box>
      )}
    </Box>
  );
}
