import React from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Box, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, AppBar, Typography, Avatar, Button } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import AssignmentIcon from '@mui/icons-material/Assignment';
import BuildIcon from '@mui/icons-material/Build';
import PeopleIcon from '@mui/icons-material/People';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import BarChartIcon from '@mui/icons-material/BarChart';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import BusinessIcon from '@mui/icons-material/Business';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import { brand } from '../brand';
import NotificationBell from './NotificationBell';

const drawerWidth = 260;

const navItems = [
  { title: 'Place Order', route: '/order', icon: <NoteAddIcon />, roles: ['customer'] },
  { title: 'Dashboard', route: '/', icon: <HomeIcon />, roles: ['admin', 'operator'] },
  { title: 'Work Orders', route: '/work-orders', icon: <AssignmentIcon />, roles: ['admin', 'operator', 'customer'] },
  { title: 'Production Board', route: '/production-board', icon: <BuildIcon />, roles: ['admin', 'operator'] },
  { title: 'Scan', route: '/scan', icon: <QrCodeScannerIcon />, roles: ['admin', 'operator'] },
  { title: 'Customers', route: '/customers', icon: <PeopleIcon />, roles: ['admin'] },
  { title: 'Delivery', route: '/delivery', icon: <LocalShippingIcon />, roles: ['admin', 'operator', 'customer'] },
  { title: 'Reports', route: '/reports', icon: <BarChartIcon />, roles: ['admin', 'operator'] },
  { title: 'Admin', route: '/admin', icon: <AdminPanelSettingsIcon />, roles: ['admin'] },
  { title: 'Departments', route: '/admin/departments', icon: <BusinessIcon />, roles: ['admin'] },
];

function isActive(route, pathname) {
  if (route === '/') return pathname === '/';
  if (route === '/admin') return pathname === '/admin';
  return pathname === route || pathname.startsWith(`${route}/`);
}

export default function Layout({ user, onLogout }) {
  const navigate = useNavigate();
  const location = useLocation();
  const initials = (user?.display_name || user?.username || 'U').charAt(0).toUpperCase();
  const visibleNavItems = navItems.filter((item) => !item.roles || item.roles.includes(user?.role));

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: brand.page }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          width: `calc(100% - ${drawerWidth}px)`,
          ml: `${drawerWidth}px`,
          bgcolor: '#fff',
          color: brand.navy,
          borderBottom: `1px solid ${brand.border}`,
        }}
      >
        <Toolbar sx={{ justifyContent: 'space-between' }}>
          <Typography variant="h6" noWrap sx={{ fontWeight: 700 }}>
            LaunchPad 3.0
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <NotificationBell user={user} />
            <Typography>{user?.display_name || user?.username || 'User'}</Typography>
            <Avatar sx={{ bgcolor: brand.navy }}>{initials}</Avatar>
            <Button color="inherit" startIcon={<LogoutIcon />} onClick={onLogout}>
              Log Out
            </Button>
          </Box>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: drawerWidth,
            boxSizing: 'border-box',
            bgcolor: brand.navyDark,
            color: '#ffffff',
            borderRight: 'none',
          },
        }}
      >
        <Box sx={{ px: 2, py: 2 }}>
          <Box
            component="img"
            src="/logo.png"
            alt="LaunchPad 3.0"
            sx={{ width: '100%', height: 'auto', bgcolor: '#fff', borderRadius: 1, p: 0.5 }}
          />
        </Box>
        <List sx={{ px: 1 }}>
          {visibleNavItems.map((item) => {
            const active = isActive(item.route, location.pathname);
            return (
              <ListItemButton
                key={item.title}
                onClick={() => navigate(item.route)}
                sx={{
                  color: '#fff',
                  borderRadius: 1,
                  mb: 0.5,
                  bgcolor: active ? brand.orange : 'transparent',
                  '&:hover': { bgcolor: active ? brand.orangeDark : 'rgba(255,255,255,0.08)' },
                }}
              >
                <ListItemIcon sx={{ color: '#fff', minWidth: 40 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.title} />
              </ListItemButton>
            );
          })}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, bgcolor: brand.page, p: 3, width: `calc(100% - ${drawerWidth}px)` }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
