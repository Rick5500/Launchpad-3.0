import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  GlobalStyles,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DocumentScannerOutlinedIcon from '@mui/icons-material/DocumentScannerOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import BrushOutlinedIcon from '@mui/icons-material/BrushOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { DivisionCredit } from '../components/AcgMark';
import CustomerShell from '../components/CustomerShell';
import BrandLogo from '../components/BrandLogo';
import { useDocumentTitle } from '../useDocumentTitle';
import { useAuth } from '../context/AuthContext';
import { authFetch } from '../api';
import { brand, formatClockLabel, formatFileSize } from '../brand';

const SERVICE_ICONS = {
  'Large Format': DescriptionOutlinedIcon,
  'Small Format': ArticleOutlinedIcon,
  'Signs & Graphics': BrushOutlinedIcon,
  Scanning: DocumentScannerOutlinedIcon,
  Planroom: GroupsOutlinedIcon,
  'Archive File Request': Inventory2OutlinedIcon,
  'Ship To (3rd Party)': LocalShippingOutlinedIcon,
};

const SHIP_TO_SERVICE = 'Ship To (3rd Party)';
const fieldSx = {
  '& .MuiInputBase-root': { bgcolor: '#fff' },
  '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': {
    borderColor: brand.navy,
    borderWidth: 2,
  },
};
const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};
const focusRing = {
  '&:focus-visible, &.Mui-focusVisible': {
    outline: `3px solid ${brand.orange}`,
    outlineOffset: 2,
  },
};
// Rail is ~66px. The submit bar is ~66px wide and ~116px on a phone. Padding clears that bar plus the label or error text.
const SCROLL_TOP = 112;
const SCROLL_BOTTOM = 184;
const OrderFieldError = React.createContext(null);

function visibleControl(target) {
  if (!target?.classList?.contains('MuiSelect-nativeInput')) return target;
  return target.closest('.MuiInputBase-root')?.querySelector('[role="combobox"]') || target;
}

function nudgeIntoClearance(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return;
  const described = String(node.getAttribute?.('aria-describedby') || '').split(/\s+/).filter(Boolean);
  const extras = described.map((id) => document.getElementById(id)).filter(Boolean);
  const label = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null;
  const helper = node.closest?.('.MuiFormControl-root')?.querySelector('.MuiFormHelperText-root.Mui-error');
  const nodes = [label, node, helper, ...extras].filter(Boolean);
  const top = Math.min(...nodes.map((el) => el.getBoundingClientRect().top));
  const bottom = Math.max(...nodes.map((el) => el.getBoundingClientRect().bottom));
  const rail = document.querySelector('[aria-label="Order steps"]');
  const footer = document.querySelector('#order-form footer');
  const limits = {
    top: (rail ? rail.getBoundingClientRect().bottom : 0) + 12,
    bottom: (footer ? footer.getBoundingClientRect().top : window.innerHeight) - 12,
  };
  let delta = 0;
  if (top < limits.top) delta = top - limits.top;
  else if (bottom > limits.bottom) delta = bottom - limits.bottom;
  if (delta !== 0) window.scrollBy({ top: delta, behavior: 'auto' });
}
const STEP_IDS = {
  contact: 'step-contact',
  delivery: 'step-delivery',
  job: 'step-job',
  files: 'step-files',
  review: 'step-review',
};
const openAllSteps = {
  [STEP_IDS.contact]: true,
  [STEP_IDS.delivery]: true,
  [STEP_IDS.job]: true,
  [STEP_IDS.files]: true,
  [STEP_IDS.review]: true,
};

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function filledAddress(line1, line2, city, state, zip) {
  const street = [line1, line2].map((value) => String(value || '').trim()).filter(Boolean).join(', ');
  const region = [String(city || '').trim(), [state, zip].map((value) => String(value || '').trim()).filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, region].filter(Boolean).join(' · ');
}

const ORIGINALS_SOURCES = [
  'Files attached below',
  'Archived files at Accent Imaging',
  'Send a vehicle to pick up originals',
  'Hardcopy or digital media provided',
];
const ORIGINALS_FILES = 'Files attached below';
const ORIGINALS_PICKUP = 'Send a vehicle to pick up originals';
const PAYMENT_METHODS = ['Accent Account', 'Cash', 'Check', 'AMEX', 'Master Card', 'Visa', 'Discover'];

const emptyBill = {
  name: '',
  phone: '',
  email: '',
  company: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  zip: '',
};

function optionValues(field) {
  return (field.options || []).map((option) => (typeof option === 'string' ? option : option.value)).filter(Boolean);
}

function proofDefault(field) {
  const choices = optionValues(field);
  if (choices.includes('None')) return 'None';
  return choices.find((option) => /digital/i.test(option)) || '';
}

function blankValues(fields) {
  const values = {};
  (fields || []).forEach((field) => {
    if (field.type === 'checkbox') values[field.key] = false;
    else if (field.type === 'multiselect') values[field.key] = [];
    else if (field.key === 'proof') values[field.key] = proofDefault(field);
    else values[field.key] = '';
  });
  return values;
}

function newLine(service) {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    service_id: service.id,
    values: blankValues(service.fields),
    file: null,
  };
}

function lineSummary(service, line) {
  const bits = (service.fields || []).map((field) => {
    const value = line.values?.[field.key];
    if (value == null || value === '' || value === false) return null;
    if (Array.isArray(value)) {
      if (!value.length) return null;
      return `${field.label}: ${value.join(', ')}`;
    }
    return `${field.label}: ${field.type === 'checkbox' ? 'Yes' : value}`;
  }).filter(Boolean);
  return bits.join(' · ') || 'New line';
}

function emptyServiceMessage(service, lines, notes, shipTo) {
  const hasLine = lines.some((line) => String(line.service_id) === String(service.id));
  if (hasLine) return null;
  if (service.name === 'Archive File Request') {
    if (String(notes || '').trim()) return null;
    return 'Archive File Request is empty. Add a line, describe the archived files in Notes, or deselect it.';
  }
  if (service.name === SHIP_TO_SERVICE) {
    if (String(shipTo || '').trim()) return null;
    return 'Ship To (3rd Party) is empty. Add a line, fill in Ship To, or deselect it.';
  }
  return `${service.name} is empty. Please add lines or deselect it.`;
}

function missingRequired(service, line) {
  for (const field of service.fields || []) {
    if (!field.required || field.is_active === false) continue;
    const value = line.values?.[field.key];
    if (field.type === 'checkbox') {
      if (!value) return `${service.name}: ${field.label} is required`;
    } else if (field.type === 'multiselect') {
      if (!Array.isArray(value) || value.length === 0) return `${service.name}: ${field.label} is required`;
    } else if (value == null || String(value).trim() === '') {
      return `${service.name}: ${field.label} is required`;
    }
  }
  return null;
}

function welcomeText(user) {
  const name = user?.contact_name || user?.display_name || user?.username || 'there';
  const company = user?.company || '';
  if (company && company !== name) return `Welcome, ${name} (${company})`;
  return `Welcome, ${name}`;
}

function billLabel(entry) {
  const who = [entry.name, entry.company].filter(Boolean).join(' — ');
  const where = [entry.city, entry.state].filter(Boolean).join(', ');
  return [who || 'Bill To', where].filter(Boolean).join(', ');
}

function LabelField({ id, label, required, span, children }) {
  return (
    <Box sx={{
      gridColumn: span ? '1 / -1' : undefined,
      display: 'grid',
      gridTemplateColumns: { xs: '1fr', md: 'minmax(112px, 148px) minmax(0, 1fr)' },
      gap: { xs: 0.4, md: 1.25 },
      alignItems: { xs: 'stretch', md: 'center' },
      minWidth: 0,
    }}
    >
      <Typography component="label" id={`${id}-label`} htmlFor={id} sx={{ fontSize: 14, fontWeight: 700, color: brand.text, lineHeight: 1.3 }}>
        {label}
        {required ? <Box component="span" aria-hidden="true" sx={{ color: brand.danger }}> *</Box> : null}
        {required ? <Box component="span" sx={visuallyHidden}> required</Box> : null}
      </Typography>
      {children}
    </Box>
  );
}

function FieldGrid({ children }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, columnGap: 2.5, rowGap: 1.25 }}>
      {children}
    </Box>
  );
}

function TextControl({
  id,
  label,
  required,
  value,
  onChange,
  disabled,
  type = 'text',
  select,
  children,
  multiline,
  minRows,
  helperText,
  placeholder,
  inputProps,
  SelectProps,
  span,
  autoComplete,
}) {
  const fieldError = useContext(OrderFieldError);
  const ownError = fieldError?.id === id ? fieldError.message : '';
  return (
    <LabelField id={id} label={label} required={required} span={span}>
      <TextField
        id={id}
        size="small"
        fullWidth
        required={Boolean(required)}
        type={type}
        select={Boolean(select)}
        value={value}
        disabled={disabled}
        onChange={onChange}
        multiline={multiline}
        minRows={minRows}
        error={Boolean(ownError)}
        helperText={ownError || helperText}
        FormHelperTextProps={ownError ? { id: `${id}-error`, role: 'alert' } : undefined}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputProps={{ 'aria-required': required ? true : undefined, ...(inputProps || {}) }}
        SelectProps={select ? { labelId: `${id}-label`, ...(SelectProps || {}) } : SelectProps}
        InputLabelProps={type === 'date' ? { shrink: true } : undefined}
        sx={fieldSx}
      >
        {children}
      </TextField>
    </LabelField>
  );
}

function Subhead({ children }) {
  return (
    <Typography component="h3" sx={{ fontWeight: 800, color: brand.navy, fontSize: 13, letterSpacing: '0.06em', textTransform: 'uppercase', borderLeft: `4px solid ${brand.orange}`, pl: 1, m: 0 }}>
      {children}
    </Typography>
  );
}

function EmptyNote({ children }) {
  return (
    <Box sx={{ border: `1px dashed ${brand.border}`, borderRadius: 1, px: 1.5, py: 1.25, bgcolor: '#F8FAFC' }}>
      <Typography sx={{ color: brand.muted, fontSize: 14 }}>{children}</Typography>
    </Box>
  );
}

function FlowSection({ id, step, title, subtitle, open, complete, onToggle, children }) {
  return (
    <Box
      id={id}
      component="section"
      aria-labelledby={`${id}-heading`}
      sx={{ scrollMarginTop: `${SCROLL_TOP}px`, scrollMarginBottom: `${SCROLL_BOTTOM}px`, bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 2, overflow: 'hidden' }}
    >
      <Box
        component="button"
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={onToggle}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 1.25,
          textAlign: 'left',
          border: 0,
          cursor: 'pointer',
          bgcolor: brand.navy,
          color: '#fff',
          px: { xs: 1.5, sm: 2 },
          py: 1.25,
          borderLeft: `4px solid ${brand.orange}`,
          ...focusRing,
        }}
      >
        <Box aria-hidden="true" sx={{ width: 28, height: 28, borderRadius: '50%', bgcolor: brand.orange, color: '#111', fontWeight: 800, display: 'grid', placeItems: 'center', flexShrink: 0, fontSize: 14 }}>
          {step}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={`${id}-heading`} sx={{ fontWeight: 800, letterSpacing: '0.03em', fontSize: { xs: 15, sm: 16 }, color: '#fff', lineHeight: 1.2 }}>
            {title}
          </Typography>
          {subtitle ? <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.88)', mt: 0.25 }}>{subtitle}</Typography> : null}
        </Box>
        {complete ? <Chip label="Ready" size="small" sx={{ bgcolor: '#fff', color: brand.navy, fontWeight: 800 }} /> : null}
        <ExpandMoreIcon aria-hidden="true" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </Box>
      <Collapse in={open}>
        <Box id={`${id}-panel`} sx={{ p: { xs: 1.5, sm: 2.5 }, display: 'grid', gap: 1.5 }}>
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}

function ReviewFact({ label, value }) {
  const text = String(value || '').trim();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: brand.muted }}>{label}</Typography>
      <Typography sx={{ fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: text ? brand.text : brand.muted }}>
        {text || 'Not entered yet'}
      </Typography>
    </Box>
  );
}

function FieldInput({ id, field, value, disabled, onChange }) {
  const choices = optionValues(field);
  const helper = field.key === 'acct_number' ? 'Ship using this account no.' : '';
  if (field.type === 'checkbox') {
    return (
      <LabelField id={id} label={field.label} required={field.required}>
        <Checkbox
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          inputProps={{ id, 'aria-required': field.required || undefined }}
        />
      </LabelField>
    );
  }
  if (field.type === 'select') {
    return (
      <LabelField id={id} label={field.label} required={field.required}>
        <TextField id={id} select size="small" fullWidth required={field.required} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} sx={fieldSx} inputProps={{ 'aria-required': field.required || undefined }} SelectProps={{ labelId: `${id}-label` }}>
          <MenuItem value="">Select</MenuItem>
          {choices.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
        </TextField>
      </LabelField>
    );
  }
  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <LabelField id={id} label={field.label} required={field.required}>
        <TextField
          id={id}
          select
          size="small"
          fullWidth
          required={field.required}
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            onChange(typeof next === 'string' ? next.split(',') : next);
          }}
          SelectProps={{
            multiple: true,
            labelId: `${id}-label`,
            renderValue: (selectedValues) => (selectedValues.length ? selectedValues.join(', ') : 'Select'),
          }}
          inputProps={{ 'aria-required': field.required || undefined }}
          sx={fieldSx}
        >
          {choices.map((option) => (
            <MenuItem key={option} value={option}>
              <Checkbox checked={selected.includes(option)} size="small" sx={{ p: 0.5, mr: 1, pointerEvents: 'none' }} />
              {option}
            </MenuItem>
          ))}
        </TextField>
      </LabelField>
    );
  }
  if (field.type === 'textarea') {
    return (
      <LabelField id={id} label={field.label} required={field.required}>
        <TextField id={id} size="small" fullWidth multiline minRows={2} required={field.required} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} sx={fieldSx} inputProps={{ 'aria-required': field.required || undefined }} />
      </LabelField>
    );
  }
  const inputType = field.type === 'number' ? 'number' : (field.key === 'date' ? 'date' : 'text');
  return (
    <LabelField id={id} label={field.label} required={field.required}>
      <TextField
        id={id}
        size="small"
        fullWidth
        type={inputType}
        required={field.required}
        value={value || ''}
        disabled={disabled}
        helperText={helper}
        onChange={(event) => onChange(field.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
        InputLabelProps={inputType === 'date' ? { shrink: true } : undefined}
        inputProps={{ 'aria-required': field.required || undefined }}
        sx={fieldSx}
      />
    </LabelField>
  );
}

function LocationChoices({
  locations,
  isStaff,
  locked,
  orderLocationId,
  defaultLocationId,
  savingDefault,
  onOrderLocation,
  onDefaultLocation,
  onSaveDefault,
}) {
  const shops = locations || [];
  if (!shops.length) return null;
  const selected = shops.find((shop) => String(shop.id) === String(orderLocationId));
  return (
    <Box data-testid="order-location-picker" sx={{ display: 'grid', gap: 1.5, mb: 1 }}>
      {!isStaff ? (
        <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', md: '1fr auto' }, alignItems: 'start' }}>
          <TextField
            select
            label="Default location"
            value={defaultLocationId}
            onChange={(event) => onDefaultLocation(event.target.value)}
            data-testid="default-location"
            helperText="Saved on your account. New orders start here."
            sx={{ '& .MuiInputBase-input': { fontSize: '1.15rem' } }}
          >
            {shops.map((shop) => <MenuItem key={shop.id} value={String(shop.id)}>{shop.name}</MenuItem>)}
          </TextField>
          <Button
            type="button"
            variant="outlined"
            disabled={savingDefault || !defaultLocationId}
            onClick={onSaveDefault}
            sx={{ mt: { md: 1 }, fontWeight: 800, borderColor: brand.navy, color: brand.navy, fontSize: '1.05rem' }}
          >
            {savingDefault ? 'Saving...' : 'Save default'}
          </Button>
        </Box>
      ) : null}
      {locked ? (
        <Typography data-testid="order-location" sx={{ fontSize: '1.2rem', fontWeight: 800, color: brand.navy }}>
          Location: {selected?.name || 'Your shop'}
        </Typography>
      ) : (
        <TextField
          select
          label="Location for this order"
          value={orderLocationId}
          onChange={(event) => onOrderLocation(event.target.value)}
          required
          data-testid="order-location"
          helperText={isStaff ? 'This order is produced at the shop you choose.' : 'Starts at your default shop. Pick another shop for this order only.'}
          sx={{ '& .MuiInputBase-input': { fontSize: '1.2rem', fontWeight: 700 } }}
        >
          {shops.map((shop) => <MenuItem key={shop.id} value={String(shop.id)}>{shop.name}</MenuItem>)}
        </TextField>
      )}
    </Box>
  );
}

export default function CustomerOrderForm({ inboundEmail = null }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const isStaff = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator';
  const [searchParams] = useSearchParams();
  const fromQuote = searchParams.get('fromQuote');
  const [quoteRequestId, setQuoteRequestId] = useState(null);
  useDocumentTitle(
    inboundEmail
      ? 'Email order'
      : quoteRequestId
        ? 'Order from quote'
        : (isStaff ? 'Create Order' : 'Customer Order Form')
  );
  const draftApplied = useRef(false);

  const [options, setOptions] = useState({ services: [], delivery_methods: [], due_window: null, payment_methods: PAYMENT_METHODS });
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [orderLocationId, setOrderLocationId] = useState('');
  const [defaultLocationId, setDefaultLocationId] = useState('');
  const [savingDefault, setSavingDefault] = useState(false);
  const [company, setCompany] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [zip, setZip] = useState('');
  const [billTo, setBillTo] = useState(emptyBill);
  const [billHistory, setBillHistory] = useState([]);
  const [billChoice, setBillChoice] = useState('');
  const [originalsSource, setOriginalsSource] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [projectNumber, setProjectNumber] = useState('');
  const [projectName, setProjectName] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [returnTo, setReturnTo] = useState('To Me');
  const [deliveryMethod, setDeliveryMethod] = useState('');
  const [upsAccount, setUpsAccount] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [attention, setAttention] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [selectedServices, setSelectedServices] = useState([]);
  const [lines, setLines] = useState([]);
  const [editor, setEditor] = useState(null);
  const [looseFiles, setLooseFiles] = useState([]);
  const [preview, setPreview] = useState(null);
  const [formError, setFormError] = useState('');
  const [fieldError, setFieldError] = useState(null);
  const revealDelay = useRef(40);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [openSteps, setOpenSteps] = useState(openAllSteps);

  function applyProfile(source, includeCompanyFallback) {
    if (!source) return;
    setCompany(source.company || (includeCompanyFallback ? source.display_name : '') || '');
    setContactName(source.contact_name || '');
    setPhone(source.phone || '');
    setEmail(source.email || '');
    setAddress1(source.address_line1 || '');
    setAddress2(source.address_line2 || '');
    setCity(source.city || '');
    setStateName(source.state || '');
    setZip(source.zip || '');
  }

  useEffect(() => {
    if (!user || isStaff) return;
    applyProfile(user, true);
  }, [user, isStaff]);

  useEffect(() => {
    if (!user) return;
    const home = user.location_id ? String(user.location_id) : '';
    if (!isStaff) {
      setDefaultLocationId((current) => current || home);
      setOrderLocationId((current) => current || home);
      return;
    }
    if (!user.all_locations && home) setOrderLocationId(home);
  }, [user, isStaff]);

  useEffect(() => {
    if (!fromQuote || inboundEmail) return undefined;
    const id = Number(fromQuote);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    let cancelled = false;
    authFetch(`/api/quote-requests/${id}/order-draft`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to open this quote');
        return body;
      })
      .then((draft) => {
        if (cancelled) return;
        setQuoteRequestId(draft.quote_request_id);
        if (draft.customer_id) setCustomerId(String(draft.customer_id));
        setCompany(draft.company || '');
        setContactName(draft.contact_name || '');
        setPhone(draft.phone || '');
        setEmail(draft.email || '');
        setAddress1(draft.address_line1 || '');
        setAddress2(draft.address_line2 || '');
        setCity(draft.city || '');
        setStateName(draft.state || '');
        setZip(draft.zip || '');
        if (draft.project_name) setProjectName(draft.project_name);
        if (draft.notes) setNotes(draft.notes);
        if (draft.due_date) setDueDate(draft.due_date);
        if (draft.files?.length) {
          setOriginalsSource(ORIGINALS_FILES);
          setLooseFiles(draft.files.map((file) => ({
            key: `quote-${file.id}`,
            id: file.id,
            original_name: file.original_name,
            size_bytes: file.size_bytes,
            status: 'uploaded',
          })));
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || 'Unable to open this quote');
      });
    return () => {
      cancelled = true;
    };
  }, [fromQuote, inboundEmail]);

  useEffect(() => {
    if (!inboundEmail || draftApplied.current) return;
    const suggestion = inboundEmail.suggestion || {};
    if (suggestion.customer_id) setCustomerId(String(suggestion.customer_id));
    if (suggestion.company) setCompany(suggestion.company);
    if (suggestion.contact_name) setContactName(suggestion.contact_name);
    if (suggestion.phone) setPhone(suggestion.phone);
    if (suggestion.email) setEmail(suggestion.email);
    if (suggestion.address_line1) setAddress1(suggestion.address_line1);
    if (suggestion.address_line2) setAddress2(suggestion.address_line2);
    if (suggestion.city) setCity(suggestion.city);
    if (suggestion.state) setStateName(suggestion.state);
    if (suggestion.zip) setZip(suggestion.zip);
    if (suggestion.po_number) setPoNumber(suggestion.po_number);
    if (suggestion.project_name) setProjectName(suggestion.project_name);
    if (suggestion.notes) setNotes(suggestion.notes);
    if (suggestion.due_date) setDueDate(suggestion.due_date);
    const kept = (inboundEmail.attachments || []).filter((file) => file.stored && !file.skipped_reason);
    if (kept.length) {
      setOriginalsSource(ORIGINALS_FILES);
      setLooseFiles(kept.map((file) => ({
        key: `inbound-${file.id}`,
        inbound: true,
        attachment_id: file.id,
        original_name: file.original_name,
        size_bytes: file.size_bytes,
        status: 'uploaded',
        id: null,
      })));
    }
    draftApplied.current = true;
  }, [inboundEmail]);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/orders/options')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Unable to load the order form');
        return body;
      })
      .then((data) => {
        if (cancelled) return;
        setOptions(data);
        const accent = (data.delivery_methods || []).find((method) => method.name === 'Accent Truck');
        setDeliveryMethod((current) => current || accent?.name || data.delivery_methods?.[0]?.name || '');
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || 'Unable to load the order form');
      });

    if (isStaff) {
      authFetch('/api/customers/lookup')
        .then(async (res) => {
          const body = await res.json().catch(() => ([]));
          if (!res.ok) throw new Error(body.error || 'Unable to load customers');
          return body;
        })
        .then((rows) => {
          if (!cancelled) setCustomers(rows || []);
        })
        .catch((err) => {
          if (!cancelled) setLoadError(err.message || 'Unable to load customers');
        });
    }

    return () => {
      cancelled = true;
    };
  }, [isStaff]);

  useEffect(() => {
    const ownerId = isStaff ? customerId : user?.id;
    if (!ownerId || result) {
      setBillHistory([]);
      return undefined;
    }
    let cancelled = false;
    const path = isStaff ? `/api/orders/bill-tos?customer_id=${ownerId}` : '/api/orders/bill-tos';
    authFetch(path)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Unable to load bill to history');
        return body;
      })
      .then((body) => {
        if (!cancelled) setBillHistory(body.bill_tos || []);
      })
      .catch(() => {
        if (!cancelled) setBillHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isStaff, customerId, user, result]);

  useEffect(() => {
    if (!selectedServices.length) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      authFetch(`/api/orders/preview?service_ids=${selectedServices.join(',')}`)
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || 'Unable to preview work orders');
          return body;
        })
        .then((data) => {
          if (!cancelled) setPreview(data);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [selectedServices]);

  const selectedServiceRows = useMemo(
    () => options.services.filter((service) => selectedServices.includes(service.id)),
    [options.services, selectedServices],
  );
  const shipService = options.services.find((service) => service.name === SHIP_TO_SERVICE);
  const shipSelected = Boolean(shipService && selectedServices.includes(shipService.id));
  const shipLines = lines.filter((line) => shipService && line.service_id === shipService.id);
  const seeShipLines = returnTo === 'See ShipTo' && shipLines.length > 0;
  const firstVia = shipLines[0]?.values?.via || '';

  const selectedDelivery = useMemo(
    () => (options.delivery_methods || []).find((method) => method.name === deliveryMethod) || null,
    [options.delivery_methods, deliveryMethod],
  );
  const activeWindow = seeShipLines
    ? (firstVia === 'Pickup at Accent' ? options.due_windows?.will_call : options.due_windows?.delivery)
    : (selectedDelivery?.will_call ? options.due_windows?.will_call : options.due_windows?.delivery) || options.due_window;
  const upsSelected = !seeShipLines && String(deliveryMethod || '').trim().toLowerCase() === 'ups';
  const filesAttached = originalsSource === ORIGINALS_FILES;
  const originalsOptions = options.originals_sources?.length ? options.originals_sources : ORIGINALS_SOURCES;
  const paymentOptions = options.payment_methods?.length ? options.payment_methods : PAYMENT_METHODS;

  useEffect(() => {
    const slots = activeWindow?.slots || [];
    if (dueTime && slots.length && !slots.includes(dueTime)) setDueTime('');
  }, [activeWindow, dueTime]);

  const uploadedFiles = useMemo(() => {
    const files = [];
    lines.forEach((line) => {
      if (line.file?.id) files.push(line.file);
    });
    looseFiles.forEach((file) => {
      if (file.id || file.inbound) files.push(file);
    });
    return files;
  }, [lines, looseFiles]);

  const uploading = [...lines.map((line) => line.file), ...looseFiles].some((file) => file && file.status === 'uploading');
  const locked = Boolean(result);

  function toggleService(service) {
    const selected = selectedServices.includes(service.id);
    if (selected) {
      const hasLines = lines.some((line) => line.service_id === service.id);
      if (hasLines && !window.confirm(`Remove ${service.name} and its line items?`)) return;
      setLines((rows) => rows.filter((line) => line.service_id !== service.id));
      setSelectedServices((current) => current.filter((id) => id !== service.id));
      if (service.name === SHIP_TO_SERVICE) setReturnTo('To Me');
      return;
    }
    setSelectedServices((current) => [...current, service.id]);
    if (service.name === SHIP_TO_SERVICE) setReturnTo('See ShipTo');
  }

  function updateLine(key, patch) {
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function uploadFile(file, assign) {
    const local = {
      key: `${file.name}-${file.size}-${Math.random()}`,
      original_name: file.name,
      size_bytes: file.size,
      status: 'uploading',
      error: '',
      id: null,
    };
    assign(local);
    const body = new FormData();
    body.append('files', file);
    if (isStaff && customerId) body.append('customer_id', customerId);
    try {
      const response = await authFetch('/api/uploads', { method: 'POST', body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Upload failed');
      const saved = payload.files?.[0];
      assign({ ...local, ...saved, status: 'uploaded', error: '' });
    } catch (err) {
      assign({ ...local, status: 'error', error: err.message || 'Upload failed' });
    }
  }

  async function removeStoredFile(file) {
    if (file?.inbound) return;
    if (file?.id) await authFetch(`/api/uploads/${file.id}`, { method: 'DELETE' });
  }

  function applyBill(entry) {
    if (!entry) {
      setBillTo(emptyBill);
      setBillChoice('');
      return;
    }
    setBillChoice(String(entry.id));
    setBillTo({
      name: entry.name || '',
      phone: entry.phone || '',
      email: entry.email || '',
      company: entry.company || '',
      address_line1: entry.address_line1 || '',
      address_line2: entry.address_line2 || '',
      city: entry.city || '',
      state: entry.state || '',
      zip: entry.zip || '',
    });
  }

  function resetForm() {
    setResult(null);
    setFormError('');
    setFieldError(null);
    setPoNumber('');
    setProjectNumber('');
    setProjectName('');
    setNotes('');
    setShipTo('');
    setAttention('');
    setUpsAccount('');
    setDueDate('');
    setDueTime('');
    setSelectedServices([]);
    setLines([]);
    setLooseFiles([]);
    setPreview(null);
    setOriginalsSource('');
    setBillTo(emptyBill);
    setBillChoice('');
    setPaymentMethod('');
    setReturnTo('To Me');
    if (!isStaff && user) applyProfile(user, true);
  }

  function saveEditor() {
    if (!editor) return;
    const service = options.services.find((row) => row.id === editor.service_id);
    const problem = service ? missingRequired(service, editor) : null;
    if (problem) {
      setEditor({ ...editor, error: problem });
      return;
    }
    setLines((rows) => {
      const index = rows.findIndex((row) => row.key === editor.key);
      const next = { key: editor.key, service_id: editor.service_id, values: editor.values, file: editor.file };
      if (index === -1) return [...rows, next];
      const copy = rows.slice();
      copy[index] = next;
      return copy;
    });
    setEditor(null);
  }

  function showFieldError(id, message) {
    const node = typeof document !== 'undefined' ? document.getElementById(id) : null;
    const section = node?.closest('section[id]');
    const collapsed = Boolean(section?.querySelector(':scope > button[aria-expanded="false"]'));
    revealDelay.current = collapsed ? 400 : 40;
    if (section?.id) {
      setOpenSteps((current) => (current[section.id] ? current : { ...current, [section.id]: true }));
    }
    setFormError('');
    setFieldError({ id, message });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setFormError('');
    if (uploading) {
      setFieldError(null);
      setFormError('Wait for file uploads to finish.');
      return;
    }
    if (!selectedServices.length) {
      const firstService = options.services[0];
      showFieldError(firstService ? `service-${firstService.id}` : 'order-services', 'Select at least one service.');
      return;
    }
    if (!projectName.trim()) {
      showFieldError('order-project-name', 'Please fill out this field.');
      return;
    }
    const addressGap = [
      ['order-address1', address1],
      ['order-city', city],
      ['order-state', stateName],
      ['order-zip', zip],
    ].find(([, value]) => !String(value || '').trim());
    if (addressGap) {
      showFieldError(addressGap[0], 'Please fill out this field.');
      return;
    }
    if (!paymentMethod) {
      showFieldError('order-payment', 'Please select an item in the list.');
      return;
    }
    if (!originalsSource) {
      showFieldError('order-originals', 'Please select an item in the list.');
      return;
    }
    const emptyRow = selectedServiceRows.find((service) => emptyServiceMessage(service, lines, notes, shipTo));
    if (emptyRow) {
      showFieldError(`add-line-${emptyRow.id}`, emptyServiceMessage(emptyRow, lines, notes, shipTo));
      return;
    }
    const invalidService = selectedServiceRows.find((service) => (
      lines.some((line) => line.service_id === service.id && missingRequired(service, line))
    ));
    if (invalidService) {
      const row = lines.find((line) => line.service_id === invalidService.id && missingRequired(invalidService, line));
      showFieldError(`add-line-${invalidService.id}`, missingRequired(invalidService, row));
      return;
    }
    const attachedCount = filesAttached
      ? [...lines.map((line) => line.file), ...looseFiles].filter((file) => file && file.status === 'uploaded' && (file.id || file.inbound)).length
      : 0;
    if (filesAttached && attachedCount === 0) {
      showFieldError('order-upload', 'Attach at least one file when originals source is Files attached below.');
      return;
    }
    const failed = [...lines.map((line) => line.file), ...looseFiles].find((file) => file && file.status === 'error');
    if (failed) {
      setFieldError(null);
      setFormError('Remove files that failed to upload before submitting.');
      return;
    }

    const payload = {
      company,
      contact_name: contactName,
      phone,
      email,
      po_number: poNumber,
      project_number: projectNumber,
      project_name: projectName,
      notes,
      originals_source: originalsSource,
      address_line1: address1,
      address_line2: address2,
      city,
      state: stateName,
      zip,
      payment_method: paymentMethod,
      return_to: returnTo,
      bill_to_name: billTo.name,
      bill_to_phone: billTo.phone,
      bill_to_email: billTo.email,
      bill_to_company: billTo.company,
      bill_to_address_line1: billTo.address_line1,
      bill_to_address_line2: billTo.address_line2,
      bill_to_city: billTo.city,
      bill_to_state: billTo.state,
      bill_to_zip: billTo.zip,
      ups_account_number: upsSelected ? upsAccount : '',
      ship_to: shipTo,
      attention,
      due_date: dueDate,
      due_time: dueTime,
      service_ids: selectedServices,
      line_items: lines.map((line) => ({
        service_id: line.service_id,
        field_values: line.values,
        file_ids: originalsSource === ORIGINALS_FILES && line.file?.id ? [line.file.id] : [],
      })),
      file_ids: originalsSource === ORIGINALS_FILES
        ? looseFiles.filter((file) => file.id && !file.inbound).map((file) => file.id)
        : [],
    };
    if (inboundEmail) {
      payload.attachment_ids = looseFiles.filter((file) => file.inbound).map((file) => file.attachment_id);
    }
    if (!seeShipLines) payload.delivery_method = deliveryMethod;
    if (isStaff) payload.customer_id = Number(customerId);
    if (orderLocationId) payload.location_id = Number(orderLocationId);
    if (quoteRequestId) payload.quote_request_id = quoteRequestId;

    setSubmitting(true);
    try {
      const response = await authFetch(inboundEmail ? `/api/inbound-emails/${inboundEmail.id}/convert` : '/api/orders', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to submit the order');
      setResult(body);
      setPreview({
        provisional: false,
        order_number: body.order_number,
        work_orders: body.work_orders || [],
      });
      window.requestAnimationFrame(() => {
        document.getElementById('order-success')?.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          block: 'start',
        });
      });
    } catch (err) {
      setFieldError(null);
      setFormError(err.message || 'Unable to submit the order');
    } finally {
      setSubmitting(false);
    }
  }

  const editorService = editor ? options.services.find((service) => service.id === editor.service_id) : null;
  const uploadedCount = uploadedFiles.filter((file) => file.status === 'uploaded').length;
  const contactComplete = Boolean(
    (!isStaff || customerId)
    && company.trim() && contactName.trim() && phone.trim() && email.trim()
    && address1.trim() && city.trim() && stateName.trim() && zip.trim(),
  );
  const deliveryComplete = Boolean(dueDate && dueTime && returnTo && (seeShipLines || deliveryMethod));
  const jobComplete = Boolean(
    projectName.trim()
    && paymentMethod
    && selectedServices.length
    && !selectedServiceRows.some((service) => emptyServiceMessage(service, lines, notes, shipTo)),
  );
  const filesComplete = Boolean(originalsSource && (!filesAttached || uploadedCount > 0) && !uploading);
  const steps = [
    { id: STEP_IDS.contact, short: 'Contact', label: 'Customer & contact', complete: contactComplete },
    { id: STEP_IDS.delivery, short: 'Delivery', label: 'Bill To, Ship To & delivery', complete: deliveryComplete },
    { id: STEP_IDS.job, short: 'Job', label: 'Job & services', complete: jobComplete },
    { id: STEP_IDS.files, short: 'Files', label: 'Files & instructions', complete: filesComplete },
    { id: STEP_IDS.review, short: 'Review', label: 'Review & submit', complete: Boolean(result) },
  ];
  const activeIndex = steps.findIndex((step) => !step.complete);
  const currentIndex = activeIndex === -1 ? steps.length - 1 : activeIndex;
  const billText = filledAddress(billTo.address_line1, billTo.address_line2, billTo.city, billTo.state, billTo.zip);
  const billWho = [billTo.name, billTo.company].filter((value) => String(value || '').trim()).join(' — ');

  useEffect(() => {
    if (!formError) return undefined;
    setOpenSteps(openAllSteps);
    const frame = window.requestAnimationFrame(() => {
      const node = document.getElementById('order-form-error');
      if (!node) return;
      node.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      node.focus();
      nudgeIntoClearance(node);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [formError]);

  useEffect(() => {
    if (!fieldError?.id) return undefined;
    const timer = window.setTimeout(() => {
      const node = document.getElementById(fieldError.id);
      if (!node) return;
      if (node.getAttribute('role') === 'combobox') node.setAttribute('aria-invalid', 'true');
      node.focus();
      node.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      nudgeIntoClearance(node);
    }, revealDelay.current);
    return () => window.clearTimeout(timer);
  }, [fieldError]);

  useEffect(() => {
    const form = document.getElementById('order-form');
    if (!form) return undefined;
    let reporting = false;
    let handling = false;
    let resetTimer = 0;
    let collapsedTimer = 0;

    function onInvalid(event) {
      if (reporting) return;
      const target = event.target;
      if (!target || target === form) return;
      const section = target.closest?.('section[id]');
      const collapsed = Boolean(section?.querySelector(':scope > button[aria-expanded="false"]'));
      const hiddenSelect = Boolean(target.classList?.contains('MuiSelect-nativeInput'));
      // Chrome can run a microtask between invalid events. A timeout stays set for the whole pass.
      if (handling) {
        if (hiddenSelect || collapsed) event.preventDefault();
        return;
      }
      handling = true;
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => { handling = false; }, 0);

      if (!hiddenSelect && !collapsed) {
        setFieldError(null);
        window.requestAnimationFrame(() => nudgeIntoClearance(target));
        return;
      }

      event.preventDefault();
      revealDelay.current = collapsed ? 400 : 40;
      if (section?.id) {
        setOpenSteps((current) => (current[section.id] ? current : { ...current, [section.id]: true }));
      }
      if (hiddenSelect) {
        const visible = visibleControl(target);
        const message = target.validationMessage || 'Please fill out this field.';
        if (visible?.id) setFieldError({ id: visible.id, message });
        return;
      }
      window.clearTimeout(collapsedTimer);
      collapsedTimer = window.setTimeout(() => {
        if (!form.contains(target)) return;
        reporting = true;
        try { target.reportValidity(); } finally { reporting = false; }
        window.requestAnimationFrame(() => nudgeIntoClearance(target));
      }, 400);
    }

    form.addEventListener('invalid', onInvalid, true);
    return () => {
      form.removeEventListener('invalid', onInvalid, true);
      window.clearTimeout(collapsedTimer);
      window.clearTimeout(resetTimer);
    };
  }, []);

  function toggleStep(id) {
    setOpenSteps((current) => ({ ...current, [id]: !current[id] }));
  }

  function jumpTo(id) {
    setOpenSteps((current) => ({ ...current, [id]: true }));
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
    });
  }


  const content = (
    <>
      <GlobalStyles styles={{
        html: { scrollPaddingTop: `${SCROLL_TOP}px`, scrollPaddingBottom: `${SCROLL_BOTTOM}px` },
        '#order-form :is(input, textarea, select, [role="combobox"], [role="checkbox"], .order-scroll-target)': {
          scrollMarginTop: `${SCROLL_TOP}px`,
          scrollMarginBottom: `${SCROLL_BOTTOM}px`,
        },
        '@media print': {
          '.no-print': { display: 'none !important' },
          body: { background: '#fff' },
          html: { scrollPaddingTop: 0, scrollPaddingBottom: 0 },
        },
      }}
      />
      <OrderFieldError.Provider value={fieldError}>
      <Box
        component="form"
        id="order-form"
        onSubmit={handleSubmit}
        onChange={(event) => {
          if (!fieldError) return;
          const target = event.target;
          const combo = target?.closest?.('.MuiInputBase-root')?.querySelector('[role="combobox"]');
          const changedId = combo?.id || target?.id;
          if (changedId && changedId === fieldError.id) setFieldError(null);
        }}
        sx={{ display: 'grid', gap: 2 }}
      >
        {result ? (
          <Box id="order-success" data-testid="success-panel" sx={{ bgcolor: '#fff', border: `2px solid ${brand.green}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 2, p: { xs: 2, sm: 3 } }}>
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
              <CheckCircleIcon sx={{ color: brand.green, fontSize: 42 }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ color: brand.green, fontWeight: 800, fontSize: { xs: 20, sm: 24 }, lineHeight: 1.2 }}>{inboundEmail ? 'Order created from the email' : 'Order Submitted Successfully!'}</Typography>
                <Typography data-testid="order-number" sx={{ mt: 0.5, fontWeight: 700, fontSize: 18 }}>Order #: {result.order_number}</Typography>
              </Box>
            </Box>
            <Typography sx={{ color: brand.navy, fontWeight: 800, mt: 2 }}>Work Orders Created</Typography>
            <Box sx={{ mt: 0.5 }}>
              {(result.work_orders || []).map((workOrder) => (
                <Typography key={workOrder.id} sx={{ fontSize: 14, mb: 0.5 }}>
                  <Box component="span" sx={{ fontWeight: 700 }}>{workOrder.external_id}</Box>
                  {' '}
                  {workOrder.service_name}
                </Typography>
              ))}
            </Box>
            <Box className="no-print" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
              <Button variant="contained" onClick={() => navigate(`/orders/${result.order.id}`)} sx={{ bgcolor: brand.navy, fontWeight: 700, textTransform: 'none', ...focusRing }}>View Submitted Order</Button>
              <Button variant="outlined" onClick={() => window.print()} sx={{ borderColor: brand.navy, color: brand.navy, fontWeight: 700, textTransform: 'none', ...focusRing }}>Print Confirmation</Button>
              {inboundEmail ? (
                <Button variant="outlined" onClick={() => navigate('/email-orders')} sx={{ borderColor: brand.navy, color: brand.navy, fontWeight: 700, textTransform: 'none', ...focusRing }}>Back to Email Orders</Button>
              ) : (
                <Button variant="outlined" onClick={resetForm} sx={{ borderColor: brand.navy, color: brand.navy, fontWeight: 700, textTransform: 'none', ...focusRing }}>Create Another Order</Button>
              )}
            </Box>
          </Box>
        ) : null}
        <Box className="no-print" sx={{ display: 'grid', gap: 2 }}>
          <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 2, p: { xs: 2, sm: 2.5 } }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
              <BrandLogo sx={{ width: { xs: 168, sm: 200 }, flex: '0 0 auto' }} />
              <Typography sx={{ color: brand.orange, fontWeight: 800, letterSpacing: '0.08em', fontSize: 12 }}>
                {isStaff ? 'STAFF ORDER' : 'CUSTOMER ORDER'}
              </Typography>
            </Box>
            <Typography variant="h4" component="h1" sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: 26, sm: 32 }, lineHeight: 1.15 }}>
              {inboundEmail ? 'Create order from this email' : quoteRequestId ? 'Create order from quote' : (isStaff ? 'Create Order' : 'Place an order')}
            </Typography>
            <Typography sx={{ mt: 1, color: brand.muted, maxWidth: 760 }}>
              {inboundEmail
                ? 'This is a draft. Review the customer, the job, and the files from the email, then create the order. Nothing is created until you submit.'
                : quoteRequestId
                  ? 'This order is filled in from the accepted quote. Choose the services, payment, and due time, then submit. The order is checked the same way as any other order.'
                : isStaff
                  ? 'Create an order for a customer. Each step stays open, so required fields are on this page. Review the work orders, then submit.'
                  : 'Place an order with Accent Imaging. Company, contact, phone, and email start from your account. Fill anything still blank, then review and submit.'}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.5 }}>
              <Chip size="small" label={isStaff ? 'Staff' : 'Your account'} sx={{ bgcolor: brand.navy, color: '#fff', fontWeight: 700 }} />
              <Chip size="small" variant="outlined" label="* Required" sx={{ borderColor: brand.navy, color: brand.navy, fontWeight: 700 }} />
              {selectedServices.length ? (
                <Chip size="small" label={countLabel(selectedServices.length, 'service', 'services')} sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 800 }} />
              ) : null}
            </Box>
          </Box>

          <Box
            role="navigation"
            aria-label="Order steps"
            sx={{
              position: 'sticky',
              top: 0,
              zIndex: 15,
              bgcolor: '#fff',
              border: `1px solid ${brand.border}`,
              borderBottom: `3px solid ${brand.orange}`,
              borderRadius: 2,
              p: 0.75,
              display: 'grid',
              gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
              gap: 0.5,
            }}
          >
            {steps.map((step, index) => {
              const current = index === currentIndex;
              return (
                <Box
                  key={step.id}
                  component="button"
                  type="button"
                  onClick={() => jumpTo(step.id)}
                  aria-current={current ? 'step' : undefined}
                  aria-label={`${index + 1}. ${step.label}${step.complete ? ', complete' : ''}`}
                  sx={{
                    border: 0,
                    cursor: 'pointer',
                    borderRadius: 1,
                    px: 0.25,
                    py: 0.75,
                    minWidth: 0,
                    bgcolor: current ? brand.navy : 'transparent',
                    color: current ? '#fff' : brand.navy,
                    ...focusRing,
                  }}
                >
                  <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.4 }}>
                    <Box aria-hidden="true" sx={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      fontSize: 12,
                      fontWeight: 800,
                      bgcolor: step.complete ? brand.orange : (current ? '#fff' : '#E7EEF8'),
                      color: '#111',
                    }}
                    >
                      {step.complete ? '✓' : index + 1}
                    </Box>
                    <Typography sx={{ fontSize: 11, fontWeight: 800, color: 'inherit', lineHeight: 1.15, textAlign: 'center' }}>{step.short}</Typography>
                  </Box>
                </Box>
              );
            })}
          </Box>

          {loadError ? <Alert severity="error">{loadError}</Alert> : null}
          {formError ? (
            <Alert id="order-form-error" tabIndex={-1} severity="error" sx={{ scrollMarginTop: `${SCROLL_TOP}px`, scrollMarginBottom: `${SCROLL_BOTTOM}px` }}>{formError}</Alert>
          ) : null}

          <FlowSection
            id={STEP_IDS.contact}
            step={1}
            title="Customer & contact"
            subtitle={isStaff ? 'Choose the customer, then confirm the contact on this order.' : 'These details print on the order. Update anything that changed.'}
            open={openSteps[STEP_IDS.contact]}
            complete={contactComplete}
            onToggle={() => toggleStep(STEP_IDS.contact)}
          >
            {isStaff ? (
              <>
                <TextControl
                  id="order-customer"
                  span
                  select
                  label="Customer"
                  required
                  value={customerId}
                  disabled={locked}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setCustomerId(nextId);
                    const match = customers.find((customer) => String(customer.id) === String(nextId));
                    if (match) applyProfile(match, true);
                    if (match && user?.all_locations && match.location_id) setOrderLocationId(String(match.location_id));
                    setBillChoice('');
                  }}
                  SelectProps={{
                    displayEmpty: true,
                    renderValue: (selected) => {
                      const match = customers.find((customer) => String(customer.id) === String(selected));
                      return match ? (match.display_name || match.username) : 'Select a customer';
                    },
                  }}
                >
                  <MenuItem value="" disabled>Select a customer</MenuItem>
                  {customers.map((customer) => (
                    <MenuItem key={customer.id} value={customer.id}>{customer.display_name || customer.username}</MenuItem>
                  ))}
                </TextControl>
                {customers.length === 0 ? <EmptyNote>No customers are available to choose.</EmptyNote> : null}
              </>
            ) : null}
            <LocationChoices
              locations={options.locations || []}
              isStaff={isStaff}
              locked={!user?.all_locations && isStaff}
              orderLocationId={orderLocationId}
              defaultLocationId={defaultLocationId}
              savingDefault={savingDefault}
              onOrderLocation={setOrderLocationId}
              onDefaultLocation={setDefaultLocationId}
              onSaveDefault={async () => {
                if (!defaultLocationId) return;
                setSavingDefault(true);
                setFormError('');
                try {
                  const response = await authFetch('/api/auth/profile', {
                    method: 'PUT',
                    body: JSON.stringify({ location_id: Number(defaultLocationId) }),
                  });
                  const body = await response.json().catch(() => ({}));
                  if (!response.ok) throw new Error(body.error || 'Unable to save the default location');
                  setOrderLocationId((current) => current || defaultLocationId);
                } catch (err) {
                  setFormError(err.message || 'Unable to save the default location');
                } finally {
                  setSavingDefault(false);
                }
              }}
            />
            <FieldGrid>
              <TextControl id="order-company" label="Company" required value={company} disabled={locked} onChange={(event) => setCompany(event.target.value)} autoComplete="organization" />
              <TextControl id="order-contact" label="Contact" required value={contactName} disabled={locked} onChange={(event) => setContactName(event.target.value)} autoComplete="name" />
              <TextControl id="order-phone" label="Phone" required value={phone} disabled={locked} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
              <TextControl id="order-email" label="Email" required type="email" value={email} disabled={locked} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
              <TextControl id="order-address1" label="Addr 1" required value={address1} disabled={locked} onChange={(event) => setAddress1(event.target.value)} autoComplete="address-line1" />
              <TextControl id="order-address2" label="Addr 2" value={address2} disabled={locked} onChange={(event) => setAddress2(event.target.value)} autoComplete="address-line2" />
              <TextControl id="order-city" label="City" required value={city} disabled={locked} onChange={(event) => setCity(event.target.value)} autoComplete="address-level2" />
              <TextControl id="order-state" label="State" required value={stateName} disabled={locked} onChange={(event) => setStateName(event.target.value)} autoComplete="address-level1" />
              <TextControl id="order-zip" label="Zip" required value={zip} disabled={locked} onChange={(event) => setZip(event.target.value)} autoComplete="postal-code" />
            </FieldGrid>
          </FlowSection>

          <FlowSection
            id={STEP_IDS.delivery}
            step={2}
            title="Bill To, Ship To & delivery"
            subtitle="Bill To is optional. Due date and time follow the delivery method."
            open={openSteps[STEP_IDS.delivery]}
            complete={deliveryComplete}
            onToggle={() => toggleStep(STEP_IDS.delivery)}
          >
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>Optional. Leave Bill To blank when the contact above is the billing contact.</Typography>
            <TextControl
              id="order-bill-previous"
              span
              select
              label="Previous"
              value={billChoice}
              disabled={locked}
              onChange={(event) => applyBill(billHistory.find((entry) => String(entry.id) === event.target.value))}
              helperText={billHistory.length ? 'Choose a previous bill-to contact, or leave this on None.' : 'No previous bill-to contacts yet.'}
            >
              <MenuItem value="">None</MenuItem>
              {billHistory.map((entry) => <MenuItem key={entry.id} value={String(entry.id)}>{billLabel(entry)}</MenuItem>)}
            </TextControl>
            <Subhead>Person</Subhead>
            <FieldGrid>
              <TextControl id="order-bill-name" label="Name" value={billTo.name} disabled={locked} onChange={(event) => setBillTo({ ...billTo, name: event.target.value })} autoComplete="name" />
              <TextControl id="order-bill-phone" label="Phone" value={billTo.phone} disabled={locked} onChange={(event) => setBillTo({ ...billTo, phone: event.target.value })} autoComplete="tel" />
              <TextControl id="order-bill-email" label="Email" value={billTo.email} disabled={locked} onChange={(event) => setBillTo({ ...billTo, email: event.target.value })} autoComplete="email" />
            </FieldGrid>
            <Subhead>Company</Subhead>
            <FieldGrid>
              <TextControl id="order-bill-company" label="Name" value={billTo.company} disabled={locked} onChange={(event) => setBillTo({ ...billTo, company: event.target.value })} autoComplete="organization" />
              <TextControl id="order-bill-address1" label="Addr 1" value={billTo.address_line1} disabled={locked} onChange={(event) => setBillTo({ ...billTo, address_line1: event.target.value })} autoComplete="address-line1" />
              <TextControl id="order-bill-address2" label="Addr 2" value={billTo.address_line2} disabled={locked} onChange={(event) => setBillTo({ ...billTo, address_line2: event.target.value })} autoComplete="address-line2" />
              <TextControl id="order-bill-city" label="City" value={billTo.city} disabled={locked} onChange={(event) => setBillTo({ ...billTo, city: event.target.value })} autoComplete="address-level2" />
              <TextControl id="order-bill-state" label="State" value={billTo.state} disabled={locked} onChange={(event) => setBillTo({ ...billTo, state: event.target.value })} autoComplete="address-level1" />
              <TextControl id="order-bill-zip" label="Zip" value={billTo.zip} disabled={locked} onChange={(event) => setBillTo({ ...billTo, zip: event.target.value })} autoComplete="postal-code" />
            </FieldGrid>

            <Subhead>Delivery</Subhead>
            <FieldGrid>
              <TextControl id="order-return" select label="Return" required value={returnTo} disabled={locked} onChange={(event) => setReturnTo(event.target.value)}>
                <MenuItem value="To Me">To Me</MenuItem>
                {shipSelected ? <MenuItem value="See ShipTo">See ShipTo</MenuItem> : null}
              </TextControl>
              {seeShipLines ? null : (
                <TextControl
                  id="order-delivery-method"
                  select
                  label="Delivery Method"
                  required
                  value={deliveryMethod}
                  disabled={locked}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDeliveryMethod(next);
                    if (String(next).trim().toLowerCase() !== 'ups') setUpsAccount('');
                  }}
                >
                  {(options.delivery_methods || []).map((method) => <MenuItem key={method.id} value={method.name}>{method.name}</MenuItem>)}
                </TextControl>
              )}
              {upsSelected ? (
                <TextControl
                  id="order-ups-account"
                  label="UPS Account"
                  value={upsAccount}
                  disabled={locked}
                  onChange={(event) => setUpsAccount(event.target.value)}
                  placeholder="Optional"
                  helperText="Optional. Letters, digits, spaces, and dashes."
                  inputProps={{ maxLength: 30, 'aria-label': 'UPS account number' }}
                />
              ) : null}
            </FieldGrid>
            {seeShipLines ? (
              <Typography sx={{ color: brand.muted, fontSize: 13 }}>
                Delivery follows the Ship To lines. Pickup at Accent uses Will Call hours. Accent Truck, Ground, 1 day, and 2 day use delivery hours. The first line&apos;s Via sets the order method.
              </Typography>
            ) : null}
            <TextControl id="order-ship-to" span label="Ship To" multiline minRows={3} value={shipTo} disabled={locked} onChange={(event) => setShipTo(event.target.value)} />
            <TextControl id="order-attention" label="Attention" value={attention} disabled={locked} onChange={(event) => setAttention(event.target.value)} />
            <FieldGrid>
              <TextControl id="order-due-date" label="Due Date" required type="date" value={dueDate} disabled={locked} onChange={(event) => setDueDate(event.target.value)} helperText="Monday–Friday, not before today." />
              <TextControl
                id="order-due-time"
                select
                label="Due Time"
                required
                value={dueTime}
                disabled={locked}
                onChange={(event) => setDueTime(event.target.value)}
                SelectProps={{
                  displayEmpty: true,
                  renderValue: (selected) => (selected ? formatClockLabel(selected) : 'Select a time'),
                }}
              >
                <MenuItem value="" disabled>Select a time</MenuItem>
                {(activeWindow?.slots || []).map((slot) => <MenuItem key={slot} value={slot}>{formatClockLabel(slot)}</MenuItem>)}
              </TextControl>
            </FieldGrid>
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>{activeWindow?.summary || 'Delivery orders 9:00 AM - 4:00 PM (15 minute increments).'}</Typography>
          </FlowSection>

          <FlowSection
            id={STEP_IDS.job}
            step={3}
            title="Job & services"
            subtitle="Name the job, choose how it will be paid, then add a line for each service."
            open={openSteps[STEP_IDS.job]}
            complete={jobComplete}
            onToggle={() => toggleStep(STEP_IDS.job)}
          >
            <FieldGrid>
              <TextControl id="order-po" label="PO Number" value={poNumber} disabled={locked} onChange={(event) => setPoNumber(event.target.value)} />
              <TextControl id="order-project-number" label="Project Number" value={projectNumber} disabled={locked} onChange={(event) => setProjectNumber(event.target.value)} />
              <TextControl id="order-project-name" span label="Project Name" required value={projectName} disabled={locked} onChange={(event) => setProjectName(event.target.value)} />
            </FieldGrid>
            <TextControl
              id="order-payment"
              span
              select
              label="Payment Method"
              required
              value={paymentMethod}
              disabled={locked}
              onChange={(event) => setPaymentMethod(event.target.value)}
              helperText="The method only. Card numbers are not collected."
              SelectProps={{
                displayEmpty: true,
                renderValue: (selected) => selected || 'Select payment method',
              }}
            >
              <MenuItem value="" disabled>Select payment method</MenuItem>
              {paymentOptions.map((method) => <MenuItem key={method} value={method}>{method}</MenuItem>)}
            </TextControl>

            <Subhead>Services</Subhead>
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>Choose every service this order needs. Each one opens its own line items.</Typography>
            {options.services.length === 0 ? <EmptyNote>No services are available right now.</EmptyNote> : null}
            <Box id="order-services" sx={{ display: 'grid', gap: 1.5 }}>
            {(fieldError?.id === 'order-services' || String(fieldError?.id || '').startsWith('service-')) ? (
              <Alert id="order-services-error" severity="error">{fieldError.message}</Alert>
            ) : null}
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 1.5 }}>
              {options.services.map((service) => {
                const selected = selectedServices.includes(service.id);
                const Icon = SERVICE_ICONS[service.name] || DescriptionOutlinedIcon;
                return (
                  <Box
                    key={service.id}
                    id={`service-${service.id}`}
                    data-testid={`service-${service.id}`}
                    aria-describedby={fieldError?.id === `service-${service.id}` ? 'order-services-error' : undefined}
                    role="checkbox"
                    aria-checked={selected}
                    aria-label={service.name}
                    tabIndex={locked ? -1 : 0}
                    onClick={() => { if (!locked) toggleService(service); }}
                    onKeyDown={(event) => {
                      if (locked) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleService(service);
                      }
                    }}
                    sx={{
                      position: 'relative',
                      border: selected ? `2px solid ${brand.navy}` : `1px solid ${brand.border}`,
                      borderLeft: selected ? `4px solid ${brand.orange}` : undefined,
                      bgcolor: selected ? '#F4F8FF' : '#fff',
                      borderRadius: 1.5,
                      minHeight: 148,
                      p: 1.5,
                      textAlign: 'center',
                      cursor: locked ? 'default' : 'pointer',
                      ...focusRing,
                    }}
                  >
                    <Checkbox checked={selected} tabIndex={-1} sx={{ position: 'absolute', top: 2, left: 2, p: 0.5, pointerEvents: 'none' }} />
                    <Icon sx={{ fontSize: 42, color: brand.navy, mt: 2 }} />
                    <Typography sx={{ fontWeight: 700, fontSize: 14, mt: 1 }}>{service.name}</Typography>
                    <Typography sx={{ color: brand.muted, fontSize: 12, mt: 0.5 }}>{service.description}</Typography>
                    {service.default_turnaround_hours ? (
                      <Typography sx={{ color: brand.muted, fontSize: 12 }}>Typical turnaround: {service.default_turnaround_hours} hours</Typography>
                    ) : null}
                  </Box>
                );
              })}
            </Box>
            </Box>

            {selectedServiceRows.map((service) => {
              const serviceLines = lines.filter((line) => line.service_id === service.id);
              let emptyCopy = 'No lines yet. Add a line with the sizes, quantities, and options for this service, or deselect it.';
              if (service.name === 'Archive File Request') {
                emptyCopy = 'No lines yet. Add a line, or describe the archived files in Special instructions.';
              } else if (service.name === SHIP_TO_SERVICE) {
                emptyCopy = 'No lines yet. Add a line, or fill in Ship To.';
              }
              return (
                <Box key={service.id} sx={{ border: `1px solid ${brand.border}`, borderLeft: `4px solid ${brand.orange}`, borderRadius: 1, overflow: 'hidden' }}>
                  <Box sx={{ px: 1.5, py: 1, bgcolor: '#F4F7FB', display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center' }}>
                    <Typography sx={{ color: brand.navy, fontWeight: 800 }}>{service.name}</Typography>
                    <Chip size="small" label={countLabel(serviceLines.length, 'line', 'lines')} sx={{ bgcolor: brand.navy, color: '#fff', fontWeight: 700 }} />
                  </Box>
                  <Box sx={{ p: 1.5, display: 'grid', gap: 1 }}>
                    {serviceLines.length === 0 ? <EmptyNote>{emptyCopy}</EmptyNote> : null}
                    {serviceLines.map((line, index) => (
                      <Box key={line.key} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', borderBottom: `1px solid ${brand.border}`, pb: 1 }}>
                        <Typography sx={{ flex: 1, minWidth: 180 }}>{index + 1}. {lineSummary(service, line)}</Typography>
                        {!locked ? (
                          <>
                            <Button type="button" size="small" sx={focusRing} onClick={() => setEditor({ ...line, values: { ...line.values }, error: '' })}>Edit</Button>
                            <Button
                              type="button"
                              size="small"
                              sx={focusRing}
                              onClick={async () => {
                                await removeStoredFile(line.file);
                                setLines((rows) => rows.filter((row) => row.key !== line.key));
                              }}
                            >
                              Remove
                            </Button>
                          </>
                        ) : null}
                      </Box>
                    ))}
                    {fieldError?.id === `add-line-${service.id}` ? (
                      <Alert id={`add-line-${service.id}-error`} severity="error">{fieldError.message}</Alert>
                    ) : null}
                    <Button
                      id={`add-line-${service.id}`}
                      type="button"
                      data-testid={`add-line-${service.id}`}
                      aria-describedby={fieldError?.id === `add-line-${service.id}` ? `add-line-${service.id}-error` : undefined}
                      startIcon={<AddIcon />}
                      disabled={locked}
                      className="order-scroll-target"
                      onClick={() => {
                        if (fieldError?.id === `add-line-${service.id}`) setFieldError(null);
                        setEditor({ ...newLine(service), error: '' });
                      }}
                      sx={{ justifySelf: 'start', color: brand.navy, fontWeight: 700, scrollMarginTop: `${SCROLL_TOP}px`, scrollMarginBottom: `${SCROLL_BOTTOM}px`, ...focusRing }}
                    >
                      Add line
                    </Button>
                  </Box>
                </Box>
              );
            })}
          </FlowSection>

          <FlowSection
            id={STEP_IDS.files}
            step={4}
            title="Files & instructions"
            subtitle="Tell the shop where the originals are, and add any notes."
            open={openSteps[STEP_IDS.files]}
            complete={filesComplete}
            onToggle={() => toggleStep(STEP_IDS.files)}
          >
            <TextControl
              id="order-originals"
              span
              select
              label="Originals Source"
              required
              value={originalsSource}
              disabled={locked}
              onChange={(event) => setOriginalsSource(event.target.value)}
              SelectProps={{
                displayEmpty: true,
                renderValue: (selected) => selected || 'Select originals source',
              }}
            >
              <MenuItem value="" disabled>Select originals source</MenuItem>
              {originalsOptions.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
            </TextControl>
            {originalsSource === ORIGINALS_PICKUP ? (
              <Typography sx={{ color: brand.muted, fontSize: 13 }}>
                This asks Accent Imaging to send a vehicle to pick up the originals. It is separate from the outbound delivery method.
              </Typography>
            ) : null}
            {filesAttached ? (
              <Box>
                <Typography sx={{ color: brand.muted, fontSize: 13, mb: 1 }}>Attach at least one file below or on a line item.</Typography>
                {uploadedFiles.length === 0 ? <EmptyNote>No files uploaded yet. Upload at least one file, or attach a file on a line.</EmptyNote> : null}
                {uploadedFiles.map((file) => (
                  <Box key={file.id || file.key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    {file.status === 'uploaded' ? <CheckCircleIcon sx={{ color: brand.green, fontSize: 18 }} /> : null}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: 14, overflowWrap: 'anywhere' }}>{file.original_name}</Typography>
                      <Typography sx={{ fontSize: 12, color: file.status === 'error' ? brand.danger : brand.muted }}>
                        {file.status === 'uploading' && 'Uploading…'}
                        {file.status === 'uploaded' && formatFileSize(file.size_bytes)}
                        {file.status === 'error' && (file.error || 'Upload failed')}
                      </Typography>
                    </Box>
                    {!locked ? (
                      <Button
                        type="button"
                        size="small"
                        color="inherit"
                        aria-label={`Remove ${file.original_name}`}
                        sx={focusRing}
                        onClick={async () => {
                          await removeStoredFile(file);
                          setLines((rows) => rows.map((row) => (row.file && (row.file.id === file.id || row.file.key === file.key) ? { ...row, file: null } : row)));
                          setLooseFiles((rows) => rows.filter((item) => item.key !== file.key));
                        }}
                      >
                        <CloseIcon fontSize="small" />
                      </Button>
                    ) : null}
                  </Box>
                ))}
                {fieldError?.id === 'order-upload' ? (
                  <Alert id="order-upload-error" severity="error" sx={{ mb: 1 }}>{fieldError.message}</Alert>
                ) : null}
                {!locked ? (
                  <Button id="order-upload" className="order-scroll-target" type="button" size="small" component="label" aria-describedby={fieldError?.id === 'order-upload' ? 'order-upload-error' : undefined} sx={{ mt: 1, color: brand.navy, fontWeight: 700, scrollMarginTop: `${SCROLL_TOP}px`, scrollMarginBottom: `${SCROLL_BOTTOM}px`, ...focusRing }}>
                    Upload Files
                    <input
                      hidden
                      type="file"
                      multiple
                      aria-label="Upload files"
                      accept=".pdf,.png,.jpg,.jpeg,.gif,.tif,.tiff,.webp,.bmp,.dwg,.zip,.plt"
                      onChange={(event) => {
                        const chosen = Array.from(event.target.files || []);
                        event.target.value = '';
                        chosen.forEach((file) => {
                          uploadFile(file, (next) => {
                            setLooseFiles((current) => {
                              const index = current.findIndex((item) => item.key === next.key);
                              if (index === -1) return [...current, next];
                              const copy = current.slice();
                              copy[index] = next;
                              return copy;
                            });
                          });
                        });
                      }}
                    />
                  </Button>
                ) : null}
              </Box>
            ) : null}
            <TextControl id="order-notes" span label="Special instructions" multiline minRows={3} value={notes} disabled={locked} onChange={(event) => setNotes(event.target.value)} placeholder="Notes for the shop" />
          </FlowSection>

          <FlowSection
            id={STEP_IDS.review}
            step={5}
            title="Review & submit"
            subtitle="Check the order, then use Submit Order. The button stays on screen."
            open={openSteps[STEP_IDS.review]}
            complete={Boolean(result)}
            onToggle={() => toggleStep(STEP_IDS.review)}
          >
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5 }}>
              <ReviewFact label="Customer" value={isStaff ? (customers.find((customer) => String(customer.id) === String(customerId))?.display_name || '') : (user?.display_name || user?.username || '')} />
              <ReviewFact label="Company" value={company} />
              <ReviewFact label="Contact" value={[contactName, phone, email].filter((value) => String(value || '').trim()).join(' · ')} />
              <ReviewFact label="Address" value={filledAddress(address1, address2, city, stateName, zip)} />
              <ReviewFact label="Bill To" value={[billWho, billTo.phone, billTo.email, billText].filter((value) => String(value || '').trim()).join(' · ')} />
              <ReviewFact label="Return" value={returnTo} />
              <ReviewFact label="Delivery" value={seeShipLines ? 'From Ship To lines' : deliveryMethod} />
              {upsSelected ? <ReviewFact label="UPS Account" value={upsAccount} /> : null}
              <ReviewFact label="Due" value={[dueDate, dueTime ? formatClockLabel(dueTime) : ''].filter(Boolean).join(' at ')} />
              <ReviewFact label="Ship To" value={shipTo} />
              <ReviewFact label="Attention" value={attention} />
              <ReviewFact label="Project" value={[projectName, poNumber && `PO ${poNumber}`, projectNumber && `#${projectNumber}`].filter(Boolean).join(' · ')} />
              <ReviewFact label="Payment" value={paymentMethod} />
              <ReviewFact label="Originals" value={originalsSource} />
              <ReviewFact label="Files" value={filesAttached ? countLabel(uploadedCount, 'file uploaded', 'files uploaded') : ''} />
              <ReviewFact label="Special instructions" value={notes} />
            </Box>
            <Box sx={{ border: `1px solid ${brand.border}`, borderLeft: `4px solid ${brand.orange}`, borderRadius: 1, p: 1.5 }}>
              <Typography sx={{ color: brand.navy, fontWeight: 800 }}>Work orders</Typography>
              <Typography sx={{ color: brand.muted, fontSize: 13, mb: 1 }}>Based on the services selected, the following work orders will be created.</Typography>
              {(preview?.work_orders || []).map((workOrder) => (
                <Typography key={workOrder.external_id} sx={{ fontSize: 14, mb: 0.5 }}>
                  <Box component="span" sx={{ fontWeight: 700 }}>{workOrder.external_id}</Box>
                  {' '}
                  {workOrder.service_name}
                </Typography>
              ))}
              {!selectedServices.length ? <EmptyNote>Select one or more services to see the work orders this order will create.</EmptyNote> : null}
              {selectedServiceRows.map((service) => {
                const serviceLines = lines.filter((line) => line.service_id === service.id);
                return (
                  <Box key={service.id} sx={{ mt: 1 }}>
                    <Typography sx={{ fontWeight: 800, color: brand.navy, fontSize: 14 }}>{service.name}</Typography>
                    {serviceLines.length === 0 ? <Typography sx={{ color: brand.muted, fontSize: 14 }}>No lines yet.</Typography> : serviceLines.map((line, index) => (
                      <Typography key={line.key} sx={{ fontSize: 14 }}>{index + 1}. {lineSummary(service, line)}</Typography>
                    ))}
                  </Box>
                );
              })}
              {preview?.provisional ? <Typography sx={{ color: brand.muted, fontSize: 12, mt: 1 }}>Numbers are reserved when you submit.</Typography> : null}
            </Box>
          </FlowSection>
        </Box>

        <Box className="no-print" component="footer" sx={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 20,
          bgcolor: '#fff',
          borderTop: `3px solid ${brand.orange}`,
          boxShadow: '0 -6px 20px rgba(10, 47, 110, 0.14)',
          px: { xs: 1.5, sm: 3 },
          py: 1.25,
        }}
        >
          <Box sx={{ maxWidth: 1440, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            {!isStaff ? <DivisionCredit height={22} /> : null}
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1.25, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between' }}>
            <Box sx={{ minWidth: 0 }}>
                <Typography aria-live="polite" sx={{ fontWeight: 800, color: brand.navy, fontSize: 15 }}>
                  {countLabel(selectedServices.length, 'service', 'services')}
                  {' · '}
                  {countLabel(lines.length, 'line', 'lines')}
                  {filesAttached ? ` · ${countLabel(uploadedCount, 'file', 'files')}` : ''}
                </Typography>
                <Typography sx={{ fontSize: 12, color: brand.muted }}>
                  {uploading ? 'Uploading files…' : result ? `Order ${result.order_number} submitted.` : 'Submit stays here while you fill the order.'}
                </Typography>
              </Box>
            <Button
              className="order-submit"
              data-testid="submit-order"
              type="submit"
              variant="contained"
              disabled={locked || submitting || uploading}
              sx={{
                bgcolor: brand.orange,
                color: '#111',
                fontWeight: 800,
                textTransform: 'none',
                px: 3,
                py: 1.15,
                boxShadow: 'none',
                '&:hover': { bgcolor: '#E07010', color: '#111' },
                '&.Mui-disabled': { bgcolor: '#E7D3BE', color: '#5E4A38' },
                '&:focus-visible, &.Mui-focusVisible': { outline: `3px solid ${brand.navy}`, outlineOffset: 2 },
              }}
            >
              {submitting ? 'Submitting…' : result ? 'Submitted' : inboundEmail ? 'Create order' : 'Submit Order'}
            </Button>
            </Box>
          </Box>
        </Box>
      </Box>
      </OrderFieldError.Provider>

      <Dialog open={Boolean(editor)} onClose={() => setEditor(null)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ bgcolor: brand.navy, color: '#fff', borderLeft: `4px solid ${brand.orange}`, fontWeight: 800 }}>
          {editorService ? editorService.name : 'Line'}
        </DialogTitle>
        <DialogContent>
          {editor?.error ? <Alert severity="error" sx={{ mb: 1 }}>{editor.error}</Alert> : null}
          <Box sx={{ display: 'grid', gap: 1.25, mt: 1 }}>
            {(editorService?.fields || []).filter((field) => field.is_active !== false).map((field) => (
              <FieldInput
                key={field.key}
                id={`line-field-${field.key}`}
                field={field}
                value={editor?.values?.[field.key]}
                disabled={locked}
                onChange={(value) => setEditor((current) => ({ ...current, values: { ...current.values, [field.key]: value } }))}
              />
            ))}
            {filesAttached && editor ? (
              <Box>
                <Typography component="label" htmlFor="line-field-file" sx={{ fontSize: 14, fontWeight: 700, mb: 0.5, display: 'block' }}>File</Typography>
                {editor.file ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography sx={{ fontSize: 14 }}>{editor.file.original_name}</Typography>
                    <Button
                      type="button"
                      size="small"
                      sx={focusRing}
                      onClick={async () => {
                        await removeStoredFile(editor.file);
                        setEditor({ ...editor, file: null });
                      }}
                    >
                      Remove
                    </Button>
                  </Box>
                ) : (
                  <Button type="button" size="small" component="label" sx={{ color: brand.navy, fontWeight: 700, ...focusRing }}>
                    Upload
                    <input
                      id="line-field-file"
                      hidden
                      type="file"
                      aria-label="Upload line file"
                      accept=".pdf,.png,.jpg,.jpeg,.gif,.tif,.tiff,.webp,.bmp,.dwg,.zip,.plt"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        uploadFile(file, (next) => setEditor((current) => (current ? { ...current, file: next } : current)));
                      }}
                    />
                  </Button>
                )}
              </Box>
            ) : null}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button type="button" onClick={() => setEditor(null)} sx={focusRing}>Cancel</Button>
          <Button
            type="button"
            variant="contained"
            onClick={saveEditor}
            sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 800, textTransform: 'none', '&:hover': { bgcolor: '#E07010' }, ...focusRing }}
          >
            Save line
          </Button>
        </DialogActions>
      </Dialog>

      <Box className="no-print" sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderLeft: `4px solid ${brand.orange}`, borderRadius: 2, overflow: 'hidden', mb: { xs: 18, sm: 14 } }}>
        <Box sx={{ bgcolor: brand.navy, px: 2, py: 1 }}>
          <Typography sx={{ color: '#fff', fontWeight: 800 }}>Important Information</Typography>
        </Box>
        <Box component="ul" sx={{ m: 0, px: 2, py: 1.5, pl: 4.5, color: brand.text, fontSize: 14 }}>
          <li>Order status is available in LaunchPad. Email updates are not enabled yet.</li>
          <li>If you have any questions, please contact us at 919-782-3332.</li>
          <li>Thank you for your business!</li>
        </Box>
      </Box>
    </>
  );
  if (inboundEmail) return content;
  return (
    <CustomerShell
      title={isStaff ? 'Create Order' : 'Customer Order Form'}
      welcome={welcomeText(user)}
      onLogout={logout}
      showDivision={false}
      extra={isStaff ? <Button color="inherit" onClick={() => navigate('/')}>Dashboard</Button> : null}
    >
      {content}
    </CustomerShell>
  );
}
