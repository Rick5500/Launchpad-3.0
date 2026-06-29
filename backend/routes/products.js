const express = require('express');
const auth = require('../auth');
const db = require('../db');

const router = express.Router();

// Middleware: Require admin role for all routes
router.use(auth.requireAuth, (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
});

// GET /api/product-categories
// Returns all product categories
router.get('/categories', (req, res) => {
  db.all(
    'SELECT * FROM product_categories ORDER BY sort_order ASC, name ASC',
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching categories:', err);
        return res.status(500).json({ error: 'Failed to fetch categories' });
      }
      res.json(rows || []);
    }
  );
});

// GET /api/products
// Returns all products with optional filtering
router.get('/', (req, res) => {
  const { category_id, is_active } = req.query;

  let query = `
    SELECT p.*, pc.name as category_name
    FROM products p
    LEFT JOIN product_categories pc ON p.category_id = pc.id
    WHERE 1=1
  `;
  const params = [];

  if (category_id) {
    query += ' AND p.category_id = ?';
    params.push(category_id);
  }

  if (is_active !== undefined) {
    query += ' AND p.is_active = ?';
    params.push(is_active === 'true' ? 1 : 0);
  }

  query += ' ORDER BY pc.sort_order ASC, p.name ASC LIMIT 500';

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error fetching products:', err);
      return res.status(500).json({ error: 'Failed to fetch products' });
    }

    if (!rows || rows.length === 0) {
      return res.json([]);
    }

    // Fetch required departments for each product
    const products = rows;
    let processedCount = 0;

    products.forEach((product) => {
      db.all(
        `SELECT prd.id, prd.product_id, d.id as department_id, d.name as department_name, prd.sort_order
         FROM product_required_departments prd
         LEFT JOIN departments d ON prd.department_id = d.id
         WHERE prd.product_id = ?
         ORDER BY prd.sort_order ASC`,
        [product.id],
        (err, departments) => {
          if (err) {
            console.error(`Error fetching departments for product ${product.id}:`, err);
            product.required_departments = [];
          } else {
            product.required_departments = departments || [];
          }

          processedCount++;
          if (processedCount === products.length) {
            res.json(products);
          }
        }
      );
    });

    // Handle empty products case
    if (products.length === 0) {
      res.json([]);
    }
  });
});

// GET /api/products/:id
// Returns a single product with its required departments
router.get('/:id', (req, res) => {
  const { id } = req.params;

  db.get(
    `SELECT p.*, pc.name as category_name
     FROM products p
     LEFT JOIN product_categories pc ON p.category_id = pc.id
     WHERE p.id = ?`,
    [id],
    (err, product) => {
      if (err) {
        console.error('Error fetching product:', err);
        return res.status(500).json({ error: 'Failed to fetch product' });
      }

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      db.all(
        `SELECT prd.id, prd.product_id, d.id as department_id, d.name as department_name, prd.sort_order
         FROM product_required_departments prd
         LEFT JOIN departments d ON prd.department_id = d.id
         WHERE prd.product_id = ?
         ORDER BY prd.sort_order ASC`,
        [id],
        (err, departments) => {
          if (err) {
            console.error(`Error fetching departments for product ${id}:`, err);
            product.required_departments = [];
          } else {
            product.required_departments = departments || [];
          }

          res.json(product);
        }
      );
    }
  );
});

// POST /api/products
// Create a new product
router.post('/', (req, res) => {
  const {
    name,
    description,
    category_id,
    proof_required,
    qc_required,
    barcode_required,
    default_turnaround_hours,
    required_department_ids,
  } = req.body;

  if (!name || !category_id) {
    return res.status(400).json({ error: 'name and category_id are required' });
  }

  db.run(
    `INSERT INTO products (name, description, category_id, is_active, proof_required, qc_required, barcode_required, default_turnaround_hours)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      name,
      description || null,
      category_id,
      proof_required ? 1 : 0,
      qc_required ? 1 : 0,
      barcode_required ? 1 : 0,
      default_turnaround_hours || null,
    ],
    function (err) {
      if (err) {
        console.error('Error creating product:', err);
        return res.status(500).json({ error: 'Failed to create product' });
      }

      const product_id = this.lastID;

      // Add required departments if provided
      if (required_department_ids && Array.isArray(required_department_ids) && required_department_ids.length > 0) {
        const insertDept = db.prepare(
          `INSERT OR IGNORE INTO product_required_departments (product_id, department_id, sort_order)
           VALUES (?, ?, ?)`
        );

        required_department_ids.forEach((dept_id, index) => {
          insertDept.run([product_id, dept_id, index]);
        });

        insertDept.finalize((err) => {
          if (err) {
            console.error('Error adding departments:', err);
          }
          res.status(201).json({ id: product_id, success: true });
        });
      } else {
        res.status(201).json({ id: product_id, success: true });
      }
    }
  );
});

// PUT /api/products/:id
// Update a product
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const {
    name,
    description,
    category_id,
    is_active,
    proof_required,
    qc_required,
    barcode_required,
    default_turnaround_hours,
    required_department_ids,
  } = req.body;

  // Build update query dynamically based on provided fields
  const updateFields = [];
  const updateParams = [];

  if (name !== undefined) {
    updateFields.push('name = ?');
    updateParams.push(name);
  }
  if (description !== undefined) {
    updateFields.push('description = ?');
    updateParams.push(description);
  }
  if (category_id !== undefined) {
    updateFields.push('category_id = ?');
    updateParams.push(category_id);
  }
  if (is_active !== undefined) {
    updateFields.push('is_active = ?');
    updateParams.push(is_active ? 1 : 0);
  }
  if (proof_required !== undefined) {
    updateFields.push('proof_required = ?');
    updateParams.push(proof_required ? 1 : 0);
  }
  if (qc_required !== undefined) {
    updateFields.push('qc_required = ?');
    updateParams.push(qc_required ? 1 : 0);
  }
  if (barcode_required !== undefined) {
    updateFields.push('barcode_required = ?');
    updateParams.push(barcode_required ? 1 : 0);
  }
  if (default_turnaround_hours !== undefined) {
    updateFields.push('default_turnaround_hours = ?');
    updateParams.push(default_turnaround_hours);
  }

  updateFields.push('updated_at = CURRENT_TIMESTAMP');

  if (updateFields.length === 1) {
    // Only updated_at was set, nothing else to update
    return res.json({ success: true });
  }

  updateParams.push(id);

  db.run(
    `UPDATE products SET ${updateFields.join(', ')} WHERE id = ?`,
    updateParams,
    (err) => {
      if (err) {
        console.error('Error updating product:', err);
        return res.status(500).json({ error: 'Failed to update product' });
      }

      // Update required departments if provided
      if (required_department_ids && Array.isArray(required_department_ids)) {
        db.run(
          'DELETE FROM product_required_departments WHERE product_id = ?',
          [id],
          (err) => {
            if (err) {
              console.error('Error clearing departments:', err);
              return res.status(500).json({ error: 'Failed to update departments' });
            }

            if (required_department_ids.length === 0) {
              return res.json({ success: true });
            }

            const insertDept = db.prepare(
              `INSERT INTO product_required_departments (product_id, department_id, sort_order)
               VALUES (?, ?, ?)`
            );

            required_department_ids.forEach((dept_id, index) => {
              insertDept.run([id, dept_id, index]);
            });

            insertDept.finalize((err) => {
              if (err) {
                console.error('Error adding departments:', err);
                return res.status(500).json({ error: 'Failed to add departments' });
              }
              res.json({ success: true });
            });
          }
        );
      } else {
        res.json({ success: true });
      }
    }
  );
});

// DELETE /api/products/:id (soft delete)
// Deactivate a product
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  db.run(
    'UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [id],
    (err) => {
      if (err) {
        console.error('Error deactivating product:', err);
        return res.status(500).json({ error: 'Failed to deactivate product' });
      }
      res.json({ success: true });
    }
  );
});

module.exports = router;
