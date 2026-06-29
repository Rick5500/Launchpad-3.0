import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Box, Drawer, List, ListItemButton, ListItemIcon, ListItemText, Toolbar, Divider, AppBar, Typography, IconButton, Avatar, Button, Chip } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import AssignmentIcon from '@mui/icons-material/Assignment';
import BuildIcon from '@mui/icons-material/Build';
import PeopleIcon from '@mui/icons-material/People';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import BarChartIcon from '@mui/icons-material/BarChart';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import LogoutIcon from '@mui/icons-material/Logout';
import BusinessIcon from '@mui/icons-material/Business';
import SecurityIcon from '@mui/icons-material/Security';
import InventoryIcon from '@mui/icons-material/Inventory';

const drawerWidth = 280;

const navItems = [
  { title: 'Dashboard', route: '/', icon: <HomeIcon />, allowedRoles: ['employee', 'manager', 'admin'] },
  { title: 'Work Orders', route: '/work-orders', icon: <AssignmentIcon />, allowedRoles: ['employee', 'manager', 'admin'] },
  { title: 'Production Board', route: '/production-board', icon: <BuildIcon />, allowedRoles: ['employee', 'manager', 'admin'] },
  { title: 'Customers', route: '/customers', icon: <PeopleIcon />, allowedRoles: ['employee', 'manager', 'admin'] },
  { title: 'Delivery', route: '/delivery', icon: <LocalShippingIcon />, allowedRoles: ['employee', 'manager', 'admin'] },
  { title: 'Reports', route: '/reports', icon: <BarChartIcon />, allowedRoles: ['manager', 'admin'] },
  { title: 'Departments', route: '/admin/departments', icon: <BusinessIcon />, allowedRoles: ['admin'] },
  { title: 'Products', route: '/admin/products', icon: <InventoryIcon />, allowedRoles: ['admin'] },
  { title: 'Users', route: '/admin/users', icon: <SecurityIcon />, allowedRoles: ['admin'] },
  { title: 'Admin Settings', route: '/admin/settings', icon: <AdminPanelSettingsIcon />, allowedRoles: ['admin'] },
];

const roleColors = {
  employee: 'default',
  manager: 'warning',
  admin: 'error',
};

export default function Layout({ user, onLogout }) {
  const navigate = useNavigate();
  const initials = (user?.display_name || user?.username || 'U').charAt(0).toUpperCase();

  // Filter nav items based on user role
  const filteredNavItems = navItems.filter(
    (item) => !item.allowedRoles || item.allowedRoles.includes(user?.role)
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <AppBar position="fixed" sx={{ width: `calc(100% - ${drawerWidth}px)`, ml: `${drawerWidth}px`, bgcolor: '#0d47a1' }}>
        <Toolbar sx={{ justifyContent: 'space-between' }}>
          <Typography variant="h6" noWrap>
            Launchpad 3.0
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography>{user?.display_name || user?.username || 'User'}</Typography>
            <Chip
              label={user?.role || 'unknown'}
              size="small"
              color={roleColors[user?.role] || 'default'}
              variant="outlined"
              sx={{ textTransform: 'capitalize' }}
            />
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
          {filteredNavItems.map((item) => (
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
