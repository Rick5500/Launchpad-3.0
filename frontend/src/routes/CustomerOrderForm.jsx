import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  GlobalStyles,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
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

const fieldSx = {
  '& .MuiInputBase-root': { bgcolor: '#fff' },
};

function newLine(serviceId) {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: '',
    size: '',
    quantity: '',
    media: '',
    color: '',
    binding_finish: '',
    mount: 'No',
    laminate: 'No',
    service_id: serviceId || '',
    file: null,
  };
}

function welcomeText(user) {
  const name = user?.contact_name || user?.display_name || user?.username || 'there';
  const company = user?.company || '';
  if (company && company !== name) return `Welcome, ${name} (${company})`;
  return `Welcome, ${name}`;
}

function Section({ title, children }) {
  return (
    <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2, height: '100%' }}>
      <Typography sx={{ color: brand.navy, fontWeight: 700, mb: 1.5, fontSize: 16 }}>{title}</Typography>
      <Box sx={{ display: 'grid', gap: 1.25 }}>{children}</Box>
    </Box>
  );
}

function LabelField({ label, required, children }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '110px 1fr' }, gap: 1, alignItems: 'center' }}>
      <Typography sx={{ fontSize: 14, color: brand.text }}>
        {label}
        {required && <Box component="span" sx={{ color: brand.danger }}> *</Box>}
      </Typography>
      {children}
    </Box>
  );
}

export default function CustomerOrderForm() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const isStaff = user?.role === 'admin' || user?.role === 'operator';

  const [options, setOptions] = useState({ services: [], delivery_methods: [], due_window: null });
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [company, setCompany] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [projectNumber, setProjectNumber] = useState('');
  const [projectName, setProjectName] = useState('');
  const [notes, setNotes] = useState('');
  const [deliveryMethod, setDeliveryMethod] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [attention, setAttention] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueTime, setDueTime] = useState('');
  const [selectedServices, setSelectedServices] = useState([]);
  const [lines, setLines] = useState([]);
  const [looseFiles, setLooseFiles] = useState([]);
  const [preview, setPreview] = useState(null);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!user || isStaff) return;
    setCompany(user.company || user.display_name || '');
    setContactName(user.contact_name || '');
    setPhone(user.phone || '');
    setEmail(user.email || '');
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

  function toggleService(serviceId) {
    setSelectedServices((current) => (
      current.includes(serviceId)
        ? current.filter((id) => id !== serviceId)
        : [...current, serviceId]
    ));
  }

  useEffect(() => {
    setLines((rows) => rows.map((row) => {
      if (selectedServices.length === 1 && row.service_id !== selectedServices[0]) {
        return { ...row, service_id: selectedServices[0] };
      }
      if (row.service_id && !selectedServices.includes(row.service_id)) {
        return { ...row, service_id: '' };
      }
      return row;
    }));
  }, [selectedServices]);

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
    if (file?.id) {
      await authFetch(`/api/uploads/${file.id}`, { method: 'DELETE' });
    }
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
    setDueDate('');
    setDueTime('');
    setSelectedServices([]);
    setLines([]);
    setLooseFiles([]);
    setPreview(null);
    if (!isStaff && user) {
      setCompany(user.company || user.display_name || '');
      setContactName(user.contact_name || '');
      setPhone(user.phone || '');
      setEmail(user.email || '');
    }
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
    if (selectedServiceRows.length > 1 && lines.some((line) => !line.service_id)) {
      setFormError('Choose a service for each line item.');
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
      delivery_method: deliveryMethod,
      ship_to: shipTo,
      attention,
      due_date: dueDate,
      due_time: dueTime,
      service_ids: selectedServices,
      line_items: lines.map((line) => ({
        description: line.description,
        size: line.size,
        quantity: line.quantity,
        media: line.media,
        color: line.color,
        binding_finish: line.binding_finish,
        mount: line.mount === 'Yes',
        laminate: line.laminate === 'Yes',
        service_id: line.service_id || undefined,
        file_ids: line.file?.id ? [line.file.id] : [],
      })),
      file_ids: looseFiles.filter((file) => file.id).map((file) => file.id),
    };
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

  const locked = Boolean(result);

  return (
    <CustomerShell
      title={isStaff ? 'Create Order' : 'Customer Order Form'}
      welcome={welcomeText(user)}
      onLogout={logout}
      extra={isStaff ? (
        <Button color="inherit" onClick={() => navigate('/')}>
          Admin Board
        </Button>
      ) : null}
    >
      <GlobalStyles
        styles={{
          '@media print': {
            '.no-print': { display: 'none !important' },
            body: { background: '#fff' },
          },
        }}
      />
      <Box
        component="form"
        id="order-form"
        onSubmit={handleSubmit}
        sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: result ? 'minmax(0, 1fr) 320px' : '1fr' }, gap: 2, alignItems: 'start' }}
      >
        <Box className="no-print" sx={{ display: 'grid', gap: 2 }}>
          {loadError && <Alert severity="error">{loadError}</Alert>}
          {formError && <Alert severity="error">{formError}</Alert>}

          {isStaff && (
            <Section title="Customer">
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
                    if (match) {
                      setCompany(match.company || match.display_name || '');
                      setContactName(match.contact_name || '');
                      setPhone(match.phone || '');
                      setEmail(match.email || '');
                    }
                  }}
                  sx={fieldSx}
                >
                  {customers.map((customer) => (
                    <MenuItem key={customer.id} value={customer.id}>
                      {customer.display_name || customer.username}
                    </MenuItem>
                  ))}
                </TextField>
              </LabelField>
            </Section>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1.15fr 1.05fr 1.15fr 0.9fr' }, gap: 2 }}>
            <Section title="Contact Information">
              <LabelField label="Company" required>
                <TextField size="small" required value={company} disabled={locked} onChange={(e) => setCompany(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Contact" required>
                <TextField size="small" required value={contactName} disabled={locked} onChange={(e) => setContactName(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Phone" required>
                <TextField size="small" required value={phone} disabled={locked} onChange={(e) => setPhone(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Email" required>
                <TextField size="small" required type="email" value={email} disabled={locked} onChange={(e) => setEmail(e.target.value)} sx={fieldSx} />
              </LabelField>
            </Section>

            <Section title="Project Information">
              <LabelField label="PO Number">
                <TextField size="small" value={poNumber} disabled={locked} onChange={(e) => setPoNumber(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Project Number">
                <TextField size="small" value={projectNumber} disabled={locked} onChange={(e) => setProjectNumber(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Project Name">
                <TextField size="small" value={projectName} disabled={locked} onChange={(e) => setProjectName(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Notes / Instructions">
                <TextField size="small" value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} sx={fieldSx} />
              </LabelField>
            </Section>

            <Section title="Delivery Information">
              <LabelField label="Delivery Method" required>
                <TextField select size="small" required value={deliveryMethod} disabled={locked} onChange={(e) => setDeliveryMethod(e.target.value)} sx={fieldSx}>
                  {(options.delivery_methods || []).map((method) => (
                    <MenuItem key={method.id} value={method.name}>{method.name}</MenuItem>
                  ))}
                </TextField>
              </LabelField>
              <LabelField label="Ship To">
                <TextField size="small" multiline minRows={3} value={shipTo} disabled={locked} onChange={(e) => setShipTo(e.target.value)} sx={fieldSx} />
              </LabelField>
              <LabelField label="Attention">
                <TextField size="small" value={attention} disabled={locked} onChange={(e) => setAttention(e.target.value)} sx={fieldSx} />
              </LabelField>
            </Section>

            <Section title="Due Date & Time">
              <LabelField label="Due Date" required>
                <TextField size="small" required type="date" value={dueDate} disabled={locked} onChange={(e) => setDueDate(e.target.value)} InputLabelProps={{ shrink: true }} sx={fieldSx} />
              </LabelField>
              <LabelField label="Due Time" required>
                <TextField select size="small" required value={dueTime} disabled={locked} onChange={(e) => setDueTime(e.target.value)} sx={fieldSx}>
                  {(options.due_window?.slots || []).map((slot) => (
                    <MenuItem key={slot} value={slot}>{formatClockLabel(slot)}</MenuItem>
                  ))}
                </TextField>
              </LabelField>
              <Typography sx={{ color: brand.muted, fontSize: 13, mt: 0.5 }}>
                {options.due_window?.summary || 'Delivery orders 9:00 AM - 2:00 PM (15 minute increments).'}
              </Typography>
            </Section>
          </Box>

          <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
            <Typography sx={{ color: brand.navy, fontWeight: 700 }}>
              Select Services <Box component="span" sx={{ fontWeight: 500, color: brand.muted }}>(Choose all that apply)</Box>
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5, mt: 1.5 }}>
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
                    onClick={() => { if (!locked) toggleService(service.id); }}
                    onKeyDown={(event) => {
                      if (locked) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleService(service.id);
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
                      <Typography sx={{ color: brand.muted, fontSize: 12 }}>
                        Typical turnaround: {service.default_turnaround_hours} hours
                      </Typography>
                    ) : null}
                  </Box>
                );
              })}
            </Box>
          </Box>

          <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
            <Typography sx={{ color: brand.navy, fontWeight: 700, mb: 1.5 }}>Line Items</Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', minWidth: 980, '& th, & td': { borderBottom: `1px solid ${brand.border}`, p: 0.75, fontSize: 13, textAlign: 'left', verticalAlign: 'middle' }, '& th': { color: brand.navy, fontWeight: 700 } }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Description</th>
                    {selectedServiceRows.length > 1 && <th>Service</th>}
                    <th>Size</th>
                    <th>Qty</th>
                    <th>Media</th>
                    <th>Color</th>
                    <th>Binding / Finish</th>
                    <th>Mount</th>
                    <th>Laminate</th>
                    <th>Upload Files</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td>{index + 1}</td>
                      <td><TextField size="small" required value={line.description} disabled={locked} onChange={(e) => updateLine(line.key, { description: e.target.value })} /></td>
                      {selectedServiceRows.length > 1 && (
                        <td>
                          <TextField select size="small" value={line.service_id} disabled={locked} onChange={(e) => updateLine(line.key, { service_id: Number(e.target.value) })} sx={{ minWidth: 140 }}>
                            {selectedServiceRows.map((service) => (
                              <MenuItem key={service.id} value={service.id}>{service.name}</MenuItem>
                            ))}
                          </TextField>
                        </td>
                      )}
                      <td><TextField size="small" value={line.size} disabled={locked} onChange={(e) => updateLine(line.key, { size: e.target.value })} sx={{ width: 90 }} /></td>
                      <td><TextField size="small" value={line.quantity} disabled={locked} onChange={(e) => updateLine(line.key, { quantity: e.target.value })} sx={{ width: 90 }} /></td>
                      <td><TextField size="small" value={line.media} disabled={locked} onChange={(e) => updateLine(line.key, { media: e.target.value })} sx={{ width: 100 }} /></td>
                      <td><TextField size="small" value={line.color} disabled={locked} onChange={(e) => updateLine(line.key, { color: e.target.value })} sx={{ width: 90 }} /></td>
                      <td><TextField size="small" value={line.binding_finish} disabled={locked} onChange={(e) => updateLine(line.key, { binding_finish: e.target.value })} sx={{ width: 130 }} /></td>
                      <td>
                        <TextField select size="small" value={line.mount} disabled={locked} onChange={(e) => updateLine(line.key, { mount: e.target.value })}>
                          <MenuItem value="No">No</MenuItem>
                          <MenuItem value="Yes">Yes</MenuItem>
                        </TextField>
                      </td>
                      <td>
                        <TextField select size="small" value={line.laminate} disabled={locked} onChange={(e) => updateLine(line.key, { laminate: e.target.value })}>
                          <MenuItem value="No">No</MenuItem>
                          <MenuItem value="Yes">Yes</MenuItem>
                        </TextField>
                      </td>
                      <td>
                        {line.file ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <Box>
                              <Typography sx={{ fontSize: 13 }}>{line.file.original_name}</Typography>
                              <Typography sx={{ fontSize: 12, color: line.file.status === 'error' ? brand.danger : brand.muted }}>
                                {line.file.status === 'uploading' && 'Uploading…'}
                                {line.file.status === 'uploaded' && formatFileSize(line.file.size_bytes)}
                                {line.file.status === 'error' && (line.file.error || 'Upload failed')}
                              </Typography>
                            </Box>
                            {!locked && (
                              <Button
                                size="small"
                                color="inherit"
                                aria-label={`Remove ${line.file.original_name}`}
                                onClick={async () => {
                                  await removeStoredFile(line.file);
                                  updateLine(line.key, { file: null });
                                }}
                              >
                                <CloseIcon fontSize="small" />
                              </Button>
                            )}
                          </Box>
                        ) : (
                          <Button size="small" component="label" disabled={locked}>
                            Upload
                            <input
                              hidden
                              type="file"
                              accept=".pdf,.png,.jpg,.jpeg,.gif,.tif,.tiff,.webp,.bmp,.dwg,.zip,.plt"
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = '';
                                if (!file) return;
                                uploadFile(file, (next) => updateLine(line.key, { file: next }));
                              }}
                            />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!lines.length && (
                    <tr>
                      <td colSpan={12}>
                        <Typography sx={{ color: brand.muted, py: 1 }}>No line items yet.</Typography>
                      </td>
                    </tr>
                  )}
                </tbody>
              </Box>
            </Box>
            <Button
              data-testid="add-line-item"
              startIcon={<AddIcon />}
              sx={{ mt: 1.5 }}
              disabled={locked}
              onClick={() => setLines((rows) => [...rows, newLine(selectedServices.length === 1 ? selectedServices[0] : '')])}
            >
              Add Line Item
            </Button>
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1.2fr auto' }, gap: 2, alignItems: 'stretch' }}>
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ color: brand.navy, fontWeight: 700, mb: 1 }}>Files Uploaded</Typography>
              {uploadedFiles.length === 0 && <Typography sx={{ color: brand.muted, fontSize: 14 }}>No files uploaded yet.</Typography>}
              {uploadedFiles.map((file) => (
                <Box key={file.id || file.key} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  {file.status === 'uploaded' && <CheckCircleIcon sx={{ color: brand.green, fontSize: 18 }} />}
                  <Box sx={{ flex: 1 }}>
                    <Typography sx={{ fontSize: 14 }}>{file.original_name}</Typography>
                    <Typography sx={{ fontSize: 12, color: file.status === 'error' ? brand.danger : brand.muted }}>
                      {file.status === 'uploading' && 'Uploading…'}
                      {file.status === 'uploaded' && formatFileSize(file.size_bytes)}
                      {file.status === 'error' && (file.error || 'Upload failed')}
                    </Typography>
                  </Box>
                  {!locked && (
                    <Button
                      size="small"
                      color="inherit"
                      aria-label={`Remove ${file.original_name}`}
                      onClick={async () => {
                        await removeStoredFile(file);
                        setLines((rows) => rows.map((row) => (row.file && (row.file.id === file.id || row.file.key === file.key) ? { ...row, file: null } : row)));
                        setLooseFiles((rows) => rows.filter((item) => item.id !== file.id && item.key !== file.key));
                      }}
                    >
                      <CloseIcon fontSize="small" />
                    </Button>
                  )}
                </Box>
              ))}
              {!locked && (
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
              )}
            </Box>

            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ color: brand.navy, fontWeight: 700 }}>Create Work Orders</Typography>
              <Typography sx={{ color: brand.muted, fontSize: 13, mb: 1 }}>
                Based on the services selected, the following work orders will be created.
              </Typography>
              {(preview?.work_orders || []).map((workOrder) => (
                <Typography key={workOrder.external_id} sx={{ fontSize: 14, mb: 0.5 }}>
                  <Box component="span" sx={{ fontWeight: 700 }}>{workOrder.external_id}</Box>
                  {' '}
                  {workOrder.service_name}
                </Typography>
              ))}
              {!selectedServices.length && (
                <Typography sx={{ color: brand.muted, fontSize: 14 }}>Select one or more services.</Typography>
              )}
              {preview?.provisional && (
                <Typography sx={{ color: brand.muted, fontSize: 12, mt: 1 }}>
                  Numbers are reserved when you submit.
                </Typography>
              )}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Button
                data-testid="submit-order"
                type="submit"
                variant="contained"
                disabled={locked || submitting || uploading}
                sx={{ bgcolor: brand.green, px: 4, py: 1.5, fontWeight: 700, '&:hover': { bgcolor: brand.greenDark } }}
              >
                {submitting ? 'Submitting…' : 'Submit Order'}
              </Button>
            </Box>
          </Box>
        </Box>

        {result && (
          <Box
            data-testid="success-panel"
            sx={{ bgcolor: '#fff', border: `2px solid ${brand.green}`, borderRadius: 1.5, p: 3, textAlign: 'center' }}
          >
            <CheckCircleIcon sx={{ color: brand.green, fontSize: 72 }} />
            <Typography sx={{ color: brand.green, fontWeight: 800, fontSize: 26, lineHeight: 1.2, mt: 1 }}>
              Order Submitted Successfully!
            </Typography>
            <Typography data-testid="order-number" sx={{ mt: 2, fontWeight: 700, fontSize: 18 }}>
              Order #: {result.order_number}
            </Typography>
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
              <Button variant="contained" onClick={() => navigate(`/orders/${result.order.id}`)} sx={{ bgcolor: brand.navy }}>
                View Submitted Order
              </Button>
              <Button variant="outlined" onClick={() => window.print()}>Print Confirmation</Button>
              <Button variant="outlined" onClick={resetForm}>Create Another Order</Button>
            </Box>
          </Box>
        )}
      </Box>

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
