const router = require('express').Router();
const path = require('path');
const multer = require('multer');
const { requireAuth, requireAdmin, requireRider, requireRiderPasswordSet } = require('../middleware/auth');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../../uploads'),
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/[^a-z0-9.\-]/gi, '_')}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are allowed'), true),
});
const auth = require('../controllers/authController');
const products = require('../controllers/productController');
const cart = require('../controllers/cartController');
const favorites = require('../controllers/favoriteController');
const orders = require('../controllers/orderController');
const admin = require('../controllers/adminController');
const delivery = require('../controllers/deliveryController');
const issues = require('../controllers/issueController');
const reports = require('../controllers/reportController');

// Auth
router.post('/auth/register', auth.register);
router.post('/auth/login', auth.login);
router.get('/auth/me', requireAuth, auth.me);

// Catalog (public)
router.get('/products', products.list);
router.get('/products/recommendations', products.recommendations); // anonymous fallback
router.get('/products/:id', products.getOne);
router.get('/brands', products.listBrands);
router.get('/categories', products.listCategories);
router.get('/recommendations', requireAuth, products.recommendations);

// Cart
router.get('/cart', requireAuth, cart.getCart);
router.post('/cart/items', requireAuth, cart.addItem);
router.patch('/cart/items/:itemId', requireAuth, cart.updateItem);
router.delete('/cart/items/:itemId', requireAuth, cart.removeItem);
router.delete('/cart', requireAuth, cart.clearCart);

// Favorites
router.get('/favorites', requireAuth, favorites.list);
router.post('/favorites', requireAuth, favorites.add);
router.delete('/favorites/:productId', requireAuth, favorites.remove);

// Orders & payment
router.post('/orders', requireAuth, orders.createOrder);
router.get('/orders', requireAuth, orders.listMyOrders);
router.get('/orders/:id', requireAuth, orders.getOrder);
router.get('/orders/:id/verify', requireAuth, orders.verifyPayment);
router.get('/payments/verify', requireAuth, orders.verifyByReference);
router.post('/paystack/webhook', orders.paystackWebhook); // signature-verified, no auth

// Issues (customer support)
router.post('/issues', requireAuth, issues.create);
router.get('/issues', requireAuth, issues.listMine);

// Delivery fees (public — checkout needs them)
router.get('/delivery-fees', delivery.listFees);

// Rider portal (phone + PIN login, JWT-protected)
router.post('/rider/login', delivery.riderLogin);
router.post('/rider/set-password', requireRider, delivery.riderSetPassword);
router.get('/rider/deliveries', requireRider, requireRiderPasswordSet, delivery.riderDeliveries);
router.post('/rider/deliveries/:id/confirm', requireRider, requireRiderPasswordSet, delivery.riderConfirmDelivery);
router.get('/rider/report', requireRider, requireRiderPasswordSet, delivery.riderReport);
router.get('/rider/report.pdf', requireRider, requireRiderPasswordSet, delivery.riderReportPdf);

// Admin — delivery management
router.get('/admin/delivery-persons', requireAdmin, delivery.listPersons);
router.post('/admin/delivery-persons', requireAdmin, delivery.createPerson);
router.patch('/admin/delivery-persons/:id', requireAdmin, delivery.updatePerson);
router.post('/admin/delivery-persons/:id/reset-pin', requireAdmin, delivery.resetPin);
router.post('/admin/delivery-persons/:id/dispatch', requireAdmin, delivery.dispatchRider);
router.patch('/admin/orders/:id/assign', requireAdmin, delivery.assignOrder);
router.put('/admin/delivery-fees', requireAdmin, delivery.upsertFee);
router.delete('/admin/delivery-fees/:id', requireAdmin, delivery.removeFee);

// Admin — image upload (returns { url } to store as a product's imageUrl)
router.post('/admin/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received' });
  res.status(201).json({ url: `/uploads/${req.file.filename}` });
});

// Admin
router.post('/admin/products', requireAdmin, admin.createProduct);
router.patch('/admin/products/:id', requireAdmin, admin.updateProduct);
router.delete('/admin/products/:id', requireAdmin, admin.deleteProduct);
router.post('/admin/products/:id/restock', requireAdmin, admin.restockProduct);
router.post('/admin/brands', requireAdmin, admin.createBrand);
router.post('/admin/categories', requireAdmin, admin.createCategory);
router.get('/admin/orders', requireAdmin, admin.listOrders);
router.patch('/admin/orders/:id/status', requireAdmin, admin.updateOrderStatus);
router.get('/admin/dashboard', requireAdmin, admin.dashboard);
router.get('/admin/reports/sales', requireAdmin, admin.salesReport);
router.get('/admin/reports/sales.pdf', requireAdmin, admin.salesReportPdf);
router.get('/admin/reports/product-sales', requireAdmin, admin.productSalesTrend);
router.get('/admin/reports/inventory', requireAdmin, admin.inventoryReport);
router.get('/admin/reports/orders', requireAdmin, reports.ordersJson);
router.get('/admin/reports/orders.pdf', requireAdmin, reports.ordersPdf);
router.get('/admin/reports/rider-deliveries', requireAdmin, reports.riderDeliveriesJson);
router.get('/admin/reports/rider-deliveries.pdf', requireAdmin, reports.riderDeliveriesPdf);

// Admin — issues
router.get('/admin/issues', requireAdmin, issues.listAll);
router.patch('/admin/issues/:id', requireAdmin, issues.respond);

module.exports = router;
