import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import { useNavigate } from 'react-router-dom';
import { brand } from '../brand';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

export default function CustomerShell({ title, welcome, children, onLogout, extra }) {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: brand.page, color: brand.text }}>
      <Box
        className="no-print"
        sx={{
          bgcolor: brand.navy,
          color: '#fff',
          px: { xs: 2, md: 4 },
          py: 1.5,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '220px 1fr auto' },
          alignItems: 'center',
          gap: 2,
        }}
      >
        <Box
          component="img"
          src="/logo.png"
          alt="LaunchPad 3.0"
          sx={{ height: 72, width: 'auto', justifySelf: { xs: 'center', md: 'start' }, bgcolor: '#fff', borderRadius: 1, px: 1 }}
        />
        <Box sx={{ textAlign: { xs: 'center', md: 'left' } }}>
          <Typography sx={{ fontSize: { xs: 22, md: 28 }, fontWeight: 700, lineHeight: 1.2 }}>{title}</Typography>
          {welcome && (
            <Typography sx={{ opacity: 0.92, fontSize: 15 }}>{welcome}</Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', justifyContent: { xs: 'center', md: 'flex-end' }, gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button color="inherit" onClick={() => navigate('/work-orders')}>
            Work Orders
          </Button>
          {extra}
          <NotificationBell user={user} />
          <Button color="inherit" startIcon={<LogoutIcon />} onClick={onLogout}>
            Log Out
          </Button>
        </Box>
      </Box>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 3, maxWidth: 1440, mx: 'auto' }}>{children}</Box>
    </Box>
  );
}
