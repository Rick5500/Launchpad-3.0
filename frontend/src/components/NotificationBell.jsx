import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Box, Button, Divider, IconButton, Menu, MenuItem, Typography } from '@mui/material';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { authFetch } from '../api';

const POLL_MS = 45000;

function formatStamp(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

export function notifyNotificationsChanged() {
  window.dispatchEvent(new CustomEvent('notifications:changed'));
}

export default function NotificationBell({ user }) {
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(null);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;

    async function load() {
      try {
        const response = await authFetch('/api/notifications?limit=8', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json();
        if (cancelled) return;
        setItems(body.notifications || []);
        setUnread(body.unread_count || 0);
      } catch {
        // The next poll retries a transient failure.
      }
    }

    load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener('notifications:changed', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('notifications:changed', load);
    };
  }, [user]);

  async function markRead(id) {
    const response = await authFetch(`/api/notifications/${id}/read`, { method: 'POST', cache: 'no-store' });
    if (!response.ok) return;
    notifyNotificationsChanged();
  }

  async function markAllRead() {
    const response = await authFetch('/api/notifications/read-all', { method: 'POST', cache: 'no-store' });
    if (!response.ok) return;
    notifyNotificationsChanged();
  }

  if (!user) return null;

  return (
    <>
      <IconButton color="inherit" aria-label="Notifications" onClick={(event) => setAnchor(event.currentTarget)}>
        <Badge badgeContent={unread} color="error" max={99} invisible={unread < 1}>
          <NotificationsIcon />
        </Badge>
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        PaperProps={{ sx: { width: 360, maxWidth: '90vw' } }}
      >
        <Box sx={{ px: 2, py: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle1">Notifications</Typography>
          <Button size="small" disabled={unread < 1} onClick={markAllRead}>
            Mark all read
          </Button>
        </Box>
        <Divider />
        {items.length === 0 && (
          <MenuItem disabled>No notifications</MenuItem>
        )}
        {items.map((item) => (
          <MenuItem
            key={item.id}
            onClick={() => {
              setAnchor(null);
              if (!item.read) markRead(item.id);
              if (item.type === 'files_shared' && item.order_id) navigate(`/orders/${item.order_id}#files-from-accent`);
              else if (item.work_order_id) navigate(`/work-orders/${item.work_order_id}`);
            }}
            sx={{ alignItems: 'flex-start', whiteSpace: 'normal', opacity: item.read ? 0.7 : 1 }}
          >
            <Box>
              <Typography variant="body2" sx={{ fontWeight: item.read ? 400 : 700 }}>
                {item.title}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block">
                {item.body}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatStamp(item.created_at)}
              </Typography>
            </Box>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem onClick={() => { setAnchor(null); navigate('/notifications'); }}>
          View all notifications
        </MenuItem>
      </Menu>
    </>
  );
}
