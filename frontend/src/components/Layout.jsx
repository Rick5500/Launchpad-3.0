import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Box, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Divider, AppBar, Typography, IconButton, Avatar, Button } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import AssignmentIcon from '@mui/icons-material/Assignment';
import BuildIcon from '@mui/icons-material/Build';
import PeopleIcon from '@mui/icons-material/People';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import BarChartIcon from '@mui/icons-material/BarChart';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import BusinessIcon from '@mui/icons-material/Business';

const drawerWidth = 280;

const navItems = [
  { title: 'Dashboard', route: '/', icon: <HomeIcon /> },
  { title: 'Work Orders', route: '/work-orders', icon: <AssignmentIcon /> },
  { title: 'Production Board', route: '/production-board', icon: <BuildIcon /> },
  { title: 'Customers', route: '/customers', icon: <PeopleIcon /> },
  { title: 'Delivery', route: '/delivery', icon: <LocalShippingIcon /> },
  { title: 'Reports', route: '/reports', icon: <BarChartIcon /> },
  { title: 'Admin', route: '/admin', icon: <AdminPanelSettingsIcon /> },
  { title: 'Departments', route: '/admin/departments', icon: <BusinessIcon /> },
];

export default function Layout({ user, onLogout }) {
  const navigate = useNavigate();
  const initials = (user?.display_name || user?.username || 'U').charAt(0).toUpperCase();

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" sx={{ width: `calc(100% - ${drawerWidth}px)`, ml: `${drawerWidth}px`, bgcolor: '#0d47a1' }}>
        <Toolbar sx={{ justifyContent: 'space-between' }}>
          <Typography variant="h6" noWrap>
            Launchpad 3.0
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography>{user?.display_name || user?.username || 'User'}</Typography>
            <Avatar>{initials}</Avatar>
            <Button color="inherit" startIcon={<LogoutIcon />} onClick={onLogout}>
              Logout
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
            bgcolor: '#131a24',
            color: '#ffffff',
          },
        }}
      >
        <Toolbar sx={{ px: 3, py: 2 }}>
          <Box>
            <Typography variant="h6">Launchpad</Typography>
            <Typography variant="body2" color="text.secondary">
              Operations dashboard
            </Typography>
          </Box>
        </Toolbar>
        <Divider sx={{ borderColor: '#2f3b4a' }} />
        <List>
          {navItems.map((item) => (
            <ListItemButton key={item.title} onClick={() => navigate(item.route)} sx={{ color: '#fff' }}>
              <ListItemIcon sx={{ color: '#90caf9' }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.title} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, bgcolor: 'background.default', p: 3, width: `calc(100% - ${drawerWidth}px)` }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
