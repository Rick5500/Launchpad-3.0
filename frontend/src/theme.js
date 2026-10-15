import { createTheme } from '@mui/material/styles';
import { brand } from './brand';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: brand.navy,
    },
    secondary: {
      main: brand.orange,
    },
    success: {
      main: brand.green,
    },
    background: {
      default: brand.page,
      paper: brand.card,
    },
    text: {
      primary: brand.text,
      secondary: brand.muted,
    },
  },
  typography: {
    fontFamily: '"Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          border: `1px solid ${brand.border}`,
          boxShadow: 'none',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        containedPrimary: {
          '&:hover': { backgroundColor: brand.navyDark },
        },
      },
    },
  },
});

export default theme;
