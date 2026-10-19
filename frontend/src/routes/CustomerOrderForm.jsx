import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
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
import CustomerShell from '../components/CustomerShell';
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
const fieldSx = { '& .MuiInputBase-root': { bgcolor: '#fff' } };

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

function LabelField({ label, required, children }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '140px 1fr' }, gap: 1, alignItems: 'center' }}>
      <Typography sx={{ fontSize: 14, color: brand.text }}>
        {label}
        {required ? <Box component="span" sx={{ color: brand.danger }}> *</Box> : null}
      </Typography>
      {children}
    </Box>
  );
}

function FormAccordion({ title, children, defaultExpanded = true }) {
  return (
    <Accordion defaultExpanded={defaultExpanded} disableGutters sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: '8px !important', '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography sx={{ color: brand.navy, fontWeight: 700 }}>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box sx={{ display: 'grid', gap: 1.25 }}>{children}</Box>
      </AccordionDetails>
    </Accordion>
  );
}

function FieldInput({ field, value, disabled, onChange }) {
  const choices = optionValues(field);
  const helper = field.key === 'acct_number' ? 'Ship using this account no.' : '';
  if (field.type === 'checkbox') {
    return (
      <LabelField label={field.label} required={field.required}>
        <Checkbox checked={Boolean(value)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      </LabelField>
    );
  }
  if (field.type === 'select') {
    return (
      <LabelField label={field.label} required={field.required}>
        <TextField select size="small" required={field.required} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} sx={fieldSx}>
          <MenuItem value="">Select</MenuItem>
          {choices.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
        </TextField>
      </LabelField>
    );
  }
  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <LabelField label={field.label} required={field.required}>
        <TextField
          select
          size="small"
          required={field.required}
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            onChange(typeof next === 'string' ? next.split(',') : next);
          }}
          SelectProps={{
            multiple: true,
            renderValue: (selectedValues) => (selectedValues.length ? selectedValues.join(', ') : 'Select'),
          }}
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
      <LabelField label={field.label} required={field.required}>
        <TextField size="small" multiline minRows={2} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)} sx={fieldSx} />
      </LabelField>
    );
  }
  const inputType = field.type === 'number' ? 'number' : (field.key === 'date' ? 'date' : 'text');
  return (
    <LabelField label={field.label} required={field.required}>
      <TextField
        size="small"
        type={inputType}
        required={field.required}
        value={value || ''}
        disabled={disabled}
        helperText={helper}
        onChange={(event) => onChange(field.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
        InputLabelProps={inputType === 'date' ? { shrink: true } : undefined}
        sx={fieldSx}
      />
    </LabelField>
  );
}

export default function CustomerOrderForm() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const isStaff = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator';

  const [options, setOptions] = useState({ services: [], delivery_methods: [], due_window: null, payment_methods: PAYMENT_METHODS });
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
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
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [loadError, setLoadError] = useState('');

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
      if (file.id) files.push(file);
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

  async function handleSubmit(event) {
    event.preventDefault();
    setFormError('');
    if (uploading) {
      setFormError('Wait for file uploads to finish.');
      return;
    }
    if (!selectedServices.length) {
      setFormError('Select at least one service.');
      return;
    }
    if (!projectName.trim()) {
      setFormError('project_name is required');
      return;
    }
    if (!address1.trim() || !city.trim() || !stateName.trim() || !zip.trim()) {
      setFormError('Company address requires Addr 1, City, State, and Zip.');
      return;
    }
    if (!paymentMethod) {
      setFormError('payment_method is required');
      return;
    }
    if (!originalsSource) {
      setFormError('originals_source is required');
      return;
    }
    const emptyService = selectedServiceRows.map((service) => emptyServiceMessage(service, lines, notes, shipTo)).find(Boolean);
    if (emptyService) {
      setFormError(emptyService);
      return;
    }
    const invalidLine = selectedServiceRows.map((service) => {
      const row = lines.find((line) => line.service_id === service.id && missingRequired(service, line));
      return row ? missingRequired(service, row) : null;
    }).find(Boolean);
    if (invalidLine) {
      setFormError(invalidLine);
      return;
    }
    const attachedCount = filesAttached
      ? [...lines.map((line) => line.file), ...looseFiles].filter((file) => file && file.id && file.status === 'uploaded').length
      : 0;
    if (filesAttached && attachedCount === 0) {
      setFormError('Attach at least one file when originals source is Files attached below');
      return;
    }
    const failed = [...lines.map((line) => line.file), ...looseFiles].find((file) => file && file.status === 'error');
    if (failed) {
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
        ? looseFiles.filter((file) => file.id).map((file) => file.id)
        : [],
    };
    if (!seeShipLines) payload.delivery_method = deliveryMethod;
    if (isStaff) payload.customer_id = Number(customerId);

    setSubmitting(true);
    try {
      const response = await authFetch('/api/orders', {
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
    } catch (err) {
      setFormError(err.message || 'Unable to submit the order');
    } finally {
      setSubmitting(false);
    }
  }

  const editorService = editor ? options.services.find((service) => service.id === editor.service_id) : null;

  return (
    <CustomerShell
      title={isStaff ? 'Create Order' : 'Customer Order Form'}
      welcome={welcomeText(user)}
      onLogout={logout}
      extra={isStaff ? <Button color="inherit" onClick={() => navigate('/')}>Admin Board</Button> : null}
    >
      <GlobalStyles styles={{ '@media print': { '.no-print': { display: 'none !important' }, body: { background: '#fff' } } }} />
      <Box component="form" id="order-form" onSubmit={handleSubmit} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: result ? 'minmax(0, 1fr) 320px' : '1fr' }, gap: 2, alignItems: 'start' }}>
        <Box className="no-print" sx={{ display: 'grid', gap: 1.5 }}>
          {loadError ? <Alert severity="error">{loadError}</Alert> : null}
          {formError ? <Alert severity="error">{formError}</Alert> : null}

          {isStaff ? (
            <FormAccordion title="Customer">
              <LabelField label="Customer" required>
                <TextField
                  select
                  size="small"
                  required
                  value={customerId}
                  disabled={locked}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    setCustomerId(nextId);
                    const match = customers.find((customer) => String(customer.id) === String(nextId));
                    if (match) applyProfile(match, true);
                    setBillChoice('');
                  }}
                  sx={fieldSx}
                >
                  {customers.map((customer) => (
                    <MenuItem key={customer.id} value={customer.id}>{customer.display_name || customer.username}</MenuItem>
                  ))}
                </TextField>
              </LabelField>
            </FormAccordion>
          ) : null}

          <FormAccordion title="Contact">
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.25 }}>
              <LabelField label="Company" required><TextField size="small" required value={company} disabled={locked} onChange={(event) => setCompany(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="Contact" required><TextField size="small" required value={contactName} disabled={locked} onChange={(event) => setContactName(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="Phone" required><TextField size="small" required value={phone} disabled={locked} onChange={(event) => setPhone(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="Email" required><TextField size="small" required type="email" value={email} disabled={locked} onChange={(event) => setEmail(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="Addr 1" required><TextField size="small" required value={address1} disabled={locked} onChange={(event) => setAddress1(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="Addr 2"><TextField size="small" value={address2} disabled={locked} onChange={(event) => setAddress2(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="City" required><TextField size="small" required value={city} disabled={locked} onChange={(event) => setCity(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="State" required><TextField size="small" required value={stateName} disabled={locked} onChange={(event) => setStateName(event.target.value)} sx={fieldSx} /></LabelField>
              <LabelField label="Zip" required><TextField size="small" required value={zip} disabled={locked} onChange={(event) => setZip(event.target.value)} sx={fieldSx} /></LabelField>
            </Box>
          </FormAccordion>

          <FormAccordion title="Bill To">
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>Optional. Leave this blank when the contact above is the billing contact.</Typography>
            <LabelField label="Previous">
              <TextField select size="small" value={billChoice} disabled={locked} onChange={(event) => applyBill(billHistory.find((entry) => String(entry.id) === event.target.value))} sx={fieldSx}>
                <MenuItem value="">None</MenuItem>
                {billHistory.map((entry) => <MenuItem key={entry.id} value={String(entry.id)}>{billLabel(entry)}</MenuItem>)}
              </TextField>
            </LabelField>
            <Typography sx={{ fontWeight: 700, color: brand.navy }}>Person</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.25 }}>
              <LabelField label="Name"><TextField size="small" value={billTo.name} disabled={locked} onChange={(event) => setBillTo({ ...billTo, name: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="Phone"><TextField size="small" value={billTo.phone} disabled={locked} onChange={(event) => setBillTo({ ...billTo, phone: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="Email"><TextField size="small" value={billTo.email} disabled={locked} onChange={(event) => setBillTo({ ...billTo, email: event.target.value })} sx={fieldSx} /></LabelField>
            </Box>
            <Typography sx={{ fontWeight: 700, color: brand.navy }}>Company</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.25 }}>
              <LabelField label="Name"><TextField size="small" value={billTo.company} disabled={locked} onChange={(event) => setBillTo({ ...billTo, company: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="Addr 1"><TextField size="small" value={billTo.address_line1} disabled={locked} onChange={(event) => setBillTo({ ...billTo, address_line1: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="Addr 2"><TextField size="small" value={billTo.address_line2} disabled={locked} onChange={(event) => setBillTo({ ...billTo, address_line2: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="City"><TextField size="small" value={billTo.city} disabled={locked} onChange={(event) => setBillTo({ ...billTo, city: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="State"><TextField size="small" value={billTo.state} disabled={locked} onChange={(event) => setBillTo({ ...billTo, state: event.target.value })} sx={fieldSx} /></LabelField>
              <LabelField label="Zip"><TextField size="small" value={billTo.zip} disabled={locked} onChange={(event) => setBillTo({ ...billTo, zip: event.target.value })} sx={fieldSx} /></LabelField>
            </Box>
          </FormAccordion>

          <FormAccordion title="Services">
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>Choose every service this order needs. Each one opens its own line items.</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}>
              {options.services.map((service) => {
                const selected = selectedServices.includes(service.id);
                const Icon = SERVICE_ICONS[service.name] || DescriptionOutlinedIcon;
                return (
                  <Box
                    key={service.id}
                    data-testid={`service-${service.id}`}
                    role="checkbox"
                    aria-checked={selected}
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
                      bgcolor: selected ? '#F4F8FF' : '#fff',
                      borderRadius: 1.5,
                      minHeight: 148,
                      p: 1.5,
                      textAlign: 'center',
                      cursor: locked ? 'default' : 'pointer',
                    }}
                  >
                    <Checkbox checked={selected} sx={{ position: 'absolute', top: 2, left: 2, p: 0.5, pointerEvents: 'none' }} />
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
          </FormAccordion>

          {selectedServiceRows.map((service) => {
            const serviceLines = lines.filter((line) => line.service_id === service.id);
            return (
              <FormAccordion key={service.id} title={service.name}>
                {serviceLines.length === 0 ? <Typography sx={{ color: brand.muted }}>No lines yet.</Typography> : null}
                {serviceLines.map((line, index) => (
                  <Box key={line.key} sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', borderBottom: `1px solid ${brand.border}`, pb: 1 }}>
                    <Typography sx={{ flex: 1, minWidth: 180 }}>{index + 1}. {lineSummary(service, line)}</Typography>
                    {!locked ? (
                      <>
                        <Button size="small" onClick={() => setEditor({ ...line, values: { ...line.values }, error: '' })}>Edit</Button>
                        <Button size="small" onClick={async () => {
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
                <Button
                  data-testid={`add-line-${service.id}`}
                  startIcon={<AddIcon />}
                  disabled={locked}
                  onClick={() => setEditor({ ...newLine(service), error: '' })}
                >
                  Add line
                </Button>
              </FormAccordion>
            );
          })}

          <FormAccordion title="Time Constraints">
            <LabelField label="Due Date" required>
              <TextField size="small" required type="date" value={dueDate} disabled={locked} onChange={(event) => setDueDate(event.target.value)} InputLabelProps={{ shrink: true }} sx={fieldSx} />
            </LabelField>
            <LabelField label="Due Time" required>
              <TextField select size="small" required value={dueTime} disabled={locked} onChange={(event) => setDueTime(event.target.value)} sx={fieldSx}>
                {(activeWindow?.slots || []).map((slot) => <MenuItem key={slot} value={slot}>{formatClockLabel(slot)}</MenuItem>)}
              </TextField>
            </LabelField>
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>{activeWindow?.summary || 'Delivery orders 9:00 AM - 4:00 PM (15 minute increments).'}</Typography>
          </FormAccordion>

          <FormAccordion title="Accounting">
            <LabelField label="PO Number"><TextField size="small" value={poNumber} disabled={locked} onChange={(event) => setPoNumber(event.target.value)} sx={fieldSx} /></LabelField>
            <LabelField label="Project Number"><TextField size="small" value={projectNumber} disabled={locked} onChange={(event) => setProjectNumber(event.target.value)} sx={fieldSx} /></LabelField>
            <LabelField label="Project Name" required><TextField size="small" required value={projectName} disabled={locked} onChange={(event) => setProjectName(event.target.value)} sx={fieldSx} /></LabelField>
          </FormAccordion>

          <FormAccordion title="Payment">
            <LabelField label="Payment Method" required>
              <TextField
                select
                size="small"
                required
                value={paymentMethod}
                disabled={locked}
                onChange={(event) => setPaymentMethod(event.target.value)}
                SelectProps={{
                  displayEmpty: true,
                  renderValue: (selected) => selected || 'Select payment method',
                }}
                sx={fieldSx}
              >
                <MenuItem value="" disabled>Select payment method</MenuItem>
                {paymentOptions.map((method) => <MenuItem key={method} value={method}>{method}</MenuItem>)}
              </TextField>
            </LabelField>
            <Typography sx={{ color: brand.muted, fontSize: 13 }}>The method only. Card numbers are not collected.</Typography>
          </FormAccordion>

          <FormAccordion title="Deliverables">
            <LabelField label="Return" required>
              <TextField
                select
                size="small"
                required
                value={returnTo}
                disabled={locked}
                onChange={(event) => setReturnTo(event.target.value)}
                sx={fieldSx}
              >
                <MenuItem value="To Me">To Me</MenuItem>
                {shipSelected ? <MenuItem value="See ShipTo">See ShipTo</MenuItem> : null}
              </TextField>
            </LabelField>
            {seeShipLines ? (
              <Typography sx={{ color: brand.muted, fontSize: 13 }}>
                Delivery follows the Ship To lines. Pickup at Accent uses Will Call hours. Accent Truck, Ground, 1 day, and 2 day use delivery hours. The first line&apos;s Via sets the order method.
              </Typography>
            ) : (
              <>
                <LabelField label="Delivery Method" required>
                  <TextField
                    select
                    size="small"
                    required
                    value={deliveryMethod}
                    disabled={locked}
                    onChange={(event) => {
                      const next = event.target.value;
                      setDeliveryMethod(next);
                      if (String(next).trim().toLowerCase() !== 'ups') setUpsAccount('');
                    }}
                    sx={fieldSx}
                  >
                    {(options.delivery_methods || []).map((method) => <MenuItem key={method.id} value={method.name}>{method.name}</MenuItem>)}
                  </TextField>
                </LabelField>
                {upsSelected ? (
                  <LabelField label="UPS Account">
                    <TextField
                      size="small"
                      value={upsAccount}
                      disabled={locked}
                      onChange={(event) => setUpsAccount(event.target.value)}
                      placeholder="Optional"
                      helperText="Optional. Letters, digits, spaces, and dashes."
                      inputProps={{ maxLength: 30, 'aria-label': 'UPS account number' }}
                      sx={fieldSx}
                    />
                  </LabelField>
                ) : null}
              </>
            )}
            <LabelField label="Ship To">
              <TextField size="small" multiline minRows={3} value={shipTo} disabled={locked} onChange={(event) => setShipTo(event.target.value)} sx={fieldSx} />
            </LabelField>
            <LabelField label="Attention">
              <TextField size="small" value={attention} disabled={locked} onChange={(event) => setAttention(event.target.value)} sx={fieldSx} />
            </LabelField>
          </FormAccordion>

          <FormAccordion title="Originals">
            <LabelField label="Originals Source" required>
              <TextField select size="small" required value={originalsSource} disabled={locked} onChange={(event) => setOriginalsSource(event.target.value)} sx={fieldSx}>
                {originalsOptions.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
              </TextField>
            </LabelField>
            {originalsSource === ORIGINALS_PICKUP ? (
              <Typography sx={{ color: brand.muted, fontSize: 13 }}>
                This asks Accent Imaging to send a vehicle to pick up the originals. It is separate from the outbound delivery method.
              </Typography>
            ) : null}
            {filesAttached ? (
              <Box>
                <Typography sx={{ color: brand.muted, fontSize: 13, mb: 1 }}>Attach at least one file below or on a line item.</Typography>
                {uploadedFiles.length === 0 ? <Typography sx={{ color: brand.muted, fontSize: 14 }}>No files uploaded yet.</Typography> : null}
                {uploadedFiles.map((file) => (
                  <Box key={file.id || file.key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    {file.status === 'uploaded' ? <CheckCircleIcon sx={{ color: brand.green, fontSize: 18 }} /> : null}
                    <Box sx={{ flex: 1 }}>
                      <Typography sx={{ fontSize: 14 }}>{file.original_name}</Typography>
                      <Typography sx={{ fontSize: 12, color: file.status === 'error' ? brand.danger : brand.muted }}>
                        {file.status === 'uploading' && 'Uploading…'}
                        {file.status === 'uploaded' && formatFileSize(file.size_bytes)}
                        {file.status === 'error' && (file.error || 'Upload failed')}
                      </Typography>
                    </Box>
                    {!locked ? (
                      <Button size="small" color="inherit" aria-label={`Remove ${file.original_name}`} onClick={async () => {
                        await removeStoredFile(file);
                        setLines((rows) => rows.map((row) => (row.file && (row.file.id === file.id || row.file.key === file.key) ? { ...row, file: null } : row)));
                        setLooseFiles((rows) => rows.filter((item) => item.id !== file.id && item.key !== file.key));
                      }}
                      >
                        <CloseIcon fontSize="small" />
                      </Button>
                    ) : null}
                  </Box>
                ))}
                {!locked ? (
                  <Button size="small" component="label" sx={{ mt: 1 }}>
                    Upload Files
                    <input
                      hidden
                      type="file"
                      multiple
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
          </FormAccordion>

          <FormAccordion title="Special Instructions">
            <TextField size="small" multiline minRows={3} value={notes} disabled={locked} onChange={(event) => setNotes(event.target.value)} placeholder="Notes for the shop" sx={fieldSx} />
          </FormAccordion>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.2fr auto' }, gap: 2, alignItems: 'stretch' }}>
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ color: brand.navy, fontWeight: 700 }}>Create Work Orders</Typography>
              <Typography sx={{ color: brand.muted, fontSize: 13, mb: 1 }}>Based on the services selected, the following work orders will be created.</Typography>
              {(preview?.work_orders || []).map((workOrder) => (
                <Typography key={workOrder.external_id} sx={{ fontSize: 14, mb: 0.5 }}>
                  <Box component="span" sx={{ fontWeight: 700 }}>{workOrder.external_id}</Box>
                  {' '}
                  {workOrder.service_name}
                </Typography>
              ))}
              {!selectedServices.length ? <Typography sx={{ color: brand.muted, fontSize: 14 }}>Select one or more services.</Typography> : null}
              {preview?.provisional ? <Typography sx={{ color: brand.muted, fontSize: 12, mt: 1 }}>Numbers are reserved when you submit.</Typography> : null}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Button data-testid="submit-order" type="submit" variant="contained" disabled={locked || submitting || uploading} sx={{ bgcolor: brand.green, px: 4, py: 1.5, fontWeight: 700, '&:hover': { bgcolor: brand.greenDark } }}>
                {submitting ? 'Submitting…' : 'Submit Order'}
              </Button>
            </Box>
          </Box>
        </Box>

        {result ? (
          <Box data-testid="success-panel" sx={{ bgcolor: '#fff', border: `2px solid ${brand.green}`, borderRadius: 1.5, p: 3, textAlign: 'center' }}>
            <CheckCircleIcon sx={{ color: brand.green, fontSize: 72 }} />
            <Typography sx={{ color: brand.green, fontWeight: 800, fontSize: 26, lineHeight: 1.2, mt: 1 }}>Order Submitted Successfully!</Typography>
            <Typography data-testid="order-number" sx={{ mt: 2, fontWeight: 700, fontSize: 18 }}>Order #: {result.order_number}</Typography>
            <Typography sx={{ color: brand.navy, fontWeight: 700, mt: 2, textAlign: 'left' }}>Work Orders Created</Typography>
            <Box sx={{ textAlign: 'left', mt: 1 }}>
              {(result.work_orders || []).map((workOrder) => (
                <Typography key={workOrder.id} sx={{ fontSize: 14, mb: 0.5 }}>
                  <Box component="span" sx={{ fontWeight: 700 }}>{workOrder.external_id}</Box>
                  {' '}
                  {workOrder.service_name}
                </Typography>
              ))}
            </Box>
            <Box className="no-print" sx={{ display: 'grid', gap: 1, mt: 3 }}>
              <Button variant="contained" onClick={() => navigate(`/orders/${result.order.id}`)} sx={{ bgcolor: brand.navy }}>View Submitted Order</Button>
              <Button variant="outlined" onClick={() => window.print()}>Print Confirmation</Button>
              <Button variant="outlined" onClick={resetForm}>Create Another Order</Button>
            </Box>
          </Box>
        ) : null}
      </Box>

      <Dialog open={Boolean(editor)} onClose={() => setEditor(null)} fullWidth maxWidth="sm">
        <DialogTitle>{editorService ? editorService.name : 'Line'}</DialogTitle>
        <DialogContent>
          {editor?.error ? <Alert severity="error" sx={{ mb: 1 }}>{editor.error}</Alert> : null}
          <Box sx={{ display: 'grid', gap: 1.25, mt: 1 }}>
            {(editorService?.fields || []).filter((field) => field.is_active !== false).map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={editor?.values?.[field.key]}
                disabled={locked}
                onChange={(value) => setEditor((current) => ({ ...current, values: { ...current.values, [field.key]: value } }))}
              />
            ))}
            {filesAttached && editor ? (
              <Box>
                <Typography sx={{ fontSize: 14, mb: 0.5 }}>File</Typography>
                {editor.file ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography sx={{ fontSize: 14 }}>{editor.file.original_name}</Typography>
                    <Button size="small" onClick={async () => {
                      await removeStoredFile(editor.file);
                      setEditor({ ...editor, file: null });
                    }}
                    >
                      Remove
                    </Button>
                  </Box>
                ) : (
                  <Button size="small" component="label">
                    Upload
                    <input
                      hidden
                      type="file"
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
          <Button onClick={() => setEditor(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveEditor}>Save line</Button>
        </DialogActions>
      </Dialog>

      <Box sx={{ mt: 2, bgcolor: '#E7F0FA', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
        <Typography sx={{ color: brand.navy, fontWeight: 700, mb: 0.5 }}>Important Information</Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5, color: brand.text, fontSize: 14 }}>
          <li>Order status is available in LaunchPad. Email updates are not enabled yet.</li>
          <li>If you have any questions, please contact us at 919-782-3332.</li>
          <li>Thank you for your business!</li>
        </Box>
      </Box>
    </CustomerShell>
  );
}
