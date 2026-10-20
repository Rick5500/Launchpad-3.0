import React, { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Box,
  Collapse,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  AppBar,
  Typography,
  Avatar,
  Button,
  IconButton,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import DashboardIcon from '@mui/icons-material/Dashboard';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import SearchIcon from '@mui/icons-material/Search';
import BarChartIcon from '@mui/icons-material/BarChart';
import PeopleIcon from '@mui/icons-material/People';
import BusinessIcon from '@mui/icons-material/Business';
import DesignServicesIcon from '@mui/icons-material/DesignServices';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import SettingsIcon from '@mui/icons-material/Settings';
import NotificationsIcon from '@mui/icons-material/Notifications';
import HistoryIcon from '@mui/icons-material/History';
import QrCode2Icon from '@mui/icons-material/QrCode2';
import QrCodeScannerIcon from '@mui/icons-material/QrCodeScanner';
import LogoutIcon from '@mui/icons-material/Logout';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import AssignmentIcon from '@mui/icons-material/Assignment';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import { brand } from '../brand';
import NotificationBell from './NotificationBell';
import HeaderScan from './HeaderScan';
import { REPORT_NAV } from '../reportCatalog';

const drawerWidth = 280;

const staffNav = [
  { title: 'Dashboard', route: '/', icon: <DashboardIcon />, roles: ['admin', 'operator', 'manager'] },
  { title: 'Create Order', route: '/order', icon: <NoteAddIcon />, roles: ['admin', 'operator', 'manager'] },
  { title: 'Scan', route: '/scan', icon: <QrCodeScannerIcon />, roles: ['admin', 'operator', 'manager'] },
  { title: 'Search Orders', route: '/search', icon: <SearchIcon />, roles: ['admin', 'operator', 'manager'] },
  { title: 'Send Files', route: '/send-files', icon: <UploadFileIcon />, roles: ['admin', 'operator', 'manager'] },
  {
    title: 'Reports',
    route: '/reports',
    icon: <BarChartIcon />,
    roles: ['admin', 'operator', 'manager'],
    children: REPORT_NAV,
  },
  { title: 'Customers', route: '/customers', icon: <PeopleIcon />, roles: ['admin'] },
  { title: 'Departments', route: '/admin/departments', icon: <BusinessIcon />, roles: ['admin'] },
  { title: 'Services', route: '/services', icon: <DesignServicesIcon />, roles: ['admin'] },
  { title: 'Users', route: '/users', icon: <ManageAccountsIcon />, roles: ['admin'] },
  { title: 'System Settings', route: '/settings', icon: <SettingsIcon />, roles: ['admin'] },
  { title: 'Notifications', route: '/notifications', icon: <NotificationsIcon />, roles: ['admin', 'operator', 'manager'] },
  { title: 'Activity Log', route: '/activity-log', icon: <HistoryIcon />, roles: ['admin'] },
  { title: 'Barcode Settings', route: '/barcode-settings', icon: <QrCode2Icon />, roles: ['admin'] },
];

const customerNav = [
  { title: 'Place Order', route: '/order', icon: <NoteAddIcon />, roles: ['customer'] },
  { title: 'Files from Accent', route: '/files', icon: <FolderSharedIcon />, roles: ['customer'] },
  { title: 'Work Orders', route: '/work-orders', icon: <AssignmentIcon />, roles: ['customer'] },
  { title: 'Delivery', route: '/delivery', icon: <LocalShippingIcon />, roles: ['customer'] },
  { title: 'Notifications', route: '/notifications', icon: <NotificationsIcon />, roles: ['customer'] },
];

function isActive(route, pathname) {
  if (route === '/') return pathname === '/';
  return pathname === route || pathname.startsWith(`${route}/`);
}

function pageTitle(pathname) {
  if (pathname === '/') return 'Dashboard';
  if (/^\/work-orders\/[^/]+\/print$/.test(pathname)) return 'Print Work Order';
  const titles = [
    ['/order', 'Create Order'],
    ['/search', 'Search Orders'],
    ['/send-files', 'Send Files'],
    ['/files', 'Files from Accent'],
    ['/reports', 'Reports'],
    ['/customers', 'Customers'],
    ['/admin/departments', 'Departments'],
    ['/services', 'Services'],
    ['/users', 'Users'],
    ['/settings', 'System Settings'],
    ['/notifications', 'Notifications'],
    ['/activity-log', 'Activity Log'],
    ['/barcode-settings', 'Barcode Settings'],
    ['/scan', 'Scan'],
    ['/production-board', 'Production Board'],
    ['/delivery', 'Delivery'],
    ['/work-orders', 'Work Orders'],
    ['/orders', 'Order'],
  ];
  const match = titles.find(([route]) => pathname === route || pathname.startsWith(`${route}/`));
  return match ? match[1] : 'LaunchPad 3.0';
}

export default function Layout({ user, onLogout }) {
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(() => location.pathname.startsWith('/reports'));

  useEffect(() => {
    if (location.pathname.startsWith('/reports')) setReportsOpen(true);
  }, [location.pathname]);
  useEffect(() => {
    document.title = pageTitle(location.pathname);
  }, [location.pathname]);
  const initials = (user?.display_name || user?.username || 'U').charAt(0).toUpperCase();
  const welcomeName = user?.display_name || user?.username || 'User';
  const items = (user?.role === 'customer' ? customerNav : staffNav)
    .filter((item) => !item.roles || item.roles.includes(user?.role));
  const showHeaderScan = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator';

  function go(route) {
    navigate(route);
    if (isMobile) setMobileOpen(false);
  }

  const drawer = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ px: 1, pt: 1.5, pb: 1 }}>
        <Box
          component="img"
          src="/logo.png"
          alt="Accent Imaging"
          sx={{ width: '100%', height: 'auto', display: 'block' }}
        />
      </Box>
      <List sx={{ px: 1, flex: 1, overflow: 'auto' }}>
        {items.map((item) => {
          const active = isActive(item.route, location.pathname);
          const buttonSx = {
            color: '#fff',
            borderRadius: 1,
            mb: 0.5,
            bgcolor: active ? brand.orange : 'transparent',
            '&:hover': { bgcolor: active ? brand.orangeDark : 'rgba(255,255,255,0.08)' },
          };
          if (item.children) {
            return (
              <Box key={item.title}>
                <ListItemButton onClick={() => go(item.route)} sx={buttonSx}>
                  <ListItemIcon sx={{ color: '#fff', minWidth: 40 }}>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.title} primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 700 : 500 }} />
                  <IconButton
                    aria-label={reportsOpen ? 'Collapse reports' : 'Expand reports'}
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      setReportsOpen((open) => !open);
                    }}
                    sx={{ color: '#fff' }}
                  >
                    {reportsOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                  </IconButton>
                </ListItemButton>
                <Collapse in={reportsOpen} timeout="auto" unmountOnExit>
                  <List disablePadding>
                    {item.children.map((child) => {
                      const childActive = location.pathname === child.route;
                      return (
                        <ListItemButton
                          key={child.route}
                          onClick={() => go(child.route)}
                          sx={{
                            color: '#fff',
                            borderRadius: 1,
                            mb: 0.25,
                            pl: 6,
                            bgcolor: childActive ? 'rgba(245,130,32,0.35)' : 'transparent',
                            '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
                          }}
                        >
                          <ListItemText primary={child.title} primaryTypographyProps={{ fontSize: 13, fontWeight: childActive ? 700 : 500 }} />
                        </ListItemButton>
                      );
                    })}
                  </List>
                </Collapse>
              </Box>
            );
          }
          return (
            <ListItemButton
              key={item.title}
              onClick={() => go(item.route)}
              sx={buttonSx}
            >
              <ListItemIcon sx={{ color: '#fff', minWidth: 40 }}>{item.icon}</ListItemIcon>
              <ListItemText primary={item.title} primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 700 : 500 }} />
            </ListItemButton>
          );
        })}
      </List>
      <List sx={{ px: 1, pb: 1 }}>
        <ListItemButton
          onClick={onLogout}
          sx={{
            color: '#fff',
            borderRadius: 1,
            '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
          }}
        >
          <ListItemIcon sx={{ color: '#fff', minWidth: 40 }}><LogoutIcon /></ListItemIcon>
          <ListItemText primary="Log Out" primaryTypographyProps={{ fontSize: 14 }} />
        </ListItemButton>
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: brand.page }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          width: { md: `calc(100% - ${drawerWidth}px)` },
          ml: { md: `${drawerWidth}px` },
          bgcolor: '#fff',
          color: brand.navy,
          borderBottom: `1px solid ${brand.border}`,
        }}
      >
        <Toolbar sx={{ position: 'relative', gap: 1, flexWrap: { xs: 'wrap', md: 'nowrap' }, py: { xs: 1, md: 0 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: { md: '1 1 0' }, zIndex: 1 }}>
            {isMobile && (
              <IconButton aria-label="Open navigation" edge="start" onClick={() => setMobileOpen(true)} sx={{ color: brand.navy }}>
                <MenuIcon />
              </IconButton>
            )}
            <Typography variant="h6" noWrap sx={{ fontWeight: 700 }}>
              {pageTitle(location.pathname)}
            </Typography>
          </Box>
          {showHeaderScan && (
            <Box
              sx={{
                order: { xs: 3, md: 0 },
                flexBasis: { xs: '100%', md: 'auto' },
                width: { xs: '100%', md: 280, lg: 400 },
                maxWidth: { md: 420 },
                position: { md: 'absolute' },
                left: { md: '50%' },
                top: { md: '50%' },
                transform: { md: 'translate(-50%, -50%)' },
                zIndex: 2,
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <HeaderScan user={user} autoFocus={location.pathname === '/'} />
            </Box>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1.5 }, flex: { md: '1 1 0' }, justifyContent: 'flex-end', zIndex: 1 }}>
            <NotificationBell user={user} />
            <Typography sx={{ display: { xs: 'none', lg: 'block' }, fontSize: 14 }}>
              Welcome, {welcomeName}
            </Typography>
            <Avatar sx={{ bgcolor: brand.navy, width: 34, height: 34, fontSize: 15 }}>{initials}</Avatar>
            <Button color="inherit" startIcon={<LogoutIcon />} onClick={onLogout} sx={{ display: { xs: 'none', sm: 'inline-flex' } }}>
              Log Out
            </Button>
          </Box>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: drawerWidth }, flexShrink: { md: 0 } }}>
        <Drawer
          variant={isMobile ? 'temporary' : 'permanent'}
          open={isMobile ? mobileOpen : true}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            '& .MuiDrawer-paper': {
              width: drawerWidth,
              boxSizing: 'border-box',
              bgcolor: brand.navyDark,
              color: '#ffffff',
              borderRight: 'none',
            },
          }}
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          bgcolor: brand.page,
          px: { xs: 1.5, md: 2.5 },
          pb: 2,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Toolbar />
        <Box sx={{ flex: 1 }}>
          <Outlet />
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', pt: 2, color: brand.muted, fontSize: 12 }}>
          <span>© 2026 Accent Imaging, Inc. All rights reserved.</span>
          <span>LaunchPad 3.0</span>
        </Box>
      </Box>
    </Box>
  );
}
