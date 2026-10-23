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
          px: { xs: 2, md: 3 },
          py: 1.25,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'auto 1fr auto' },
          alignItems: 'center',
          gap: { xs: 1.5, md: 2 },
        }}
      >
        <Box
          component="img"
          src="/logo.png"
          alt="Accent Imaging"
          sx={{
            height: { xs: 68, md: 80 },
            width: 'auto',
            maxWidth: '100%',
            display: 'block',
            justifySelf: { xs: 'center', md: 'start' },
          }}
        />
        <Box sx={{ textAlign: { xs: 'center', md: 'left' } }}>
          <Typography sx={{ fontSize: { xs: 22, md: 28 }, fontWeight: 700, lineHeight: 1.2 }}>{title}</Typography>
          {welcome && (
            <Typography sx={{ opacity: 0.92, fontSize: 15 }}>{welcome}</Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', justifyContent: { xs: 'center', md: 'flex-end' }, gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {user?.role === 'customer' ? (
            <Button color="inherit" onClick={() => navigate('/files')}>
              Files from Accent
            </Button>
          ) : (
            <Button color="inherit" onClick={() => navigate('/send-files')}>
              Send Files
            </Button>
          )}
          <Button color="inherit" onClick={() => navigate('/work-orders')}>
            Work Orders
          </Button>
          <Button color="inherit" onClick={() => navigate('/proofs')}>
            Proofs
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
