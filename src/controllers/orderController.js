const { sequelize, Order, OrderItem, Payment, Product, Brand, Inventory, CartItem, User, OrderStatusHistory, InventoryLog } = require('../models');
const paystack = require('../services/paystack');
const { sendSms } = require('../services/naloSms');

function generateOrderNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `VX-${stamp}-${rand}`;
}

/**
 * POST /orders — builds an order from the user's cart, reserves stock,
 * and returns a Paystack authorization_url to complete payment.
 */
async function createOrder(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const { address, street, area, city, region, shippingCost = 0 } = req.body;
    if (!address || !city || !region) {
      await t.rollback();
      return res.status(400).json({ error: 'address, city and region are required' });
    }
    const shippingAddress = [address, street, area, city, region].filter(Boolean).join(', ');
    const user = await User.findByPk(req.user.id);
    const cartItems = await CartItem.findAll({
      where: { UserId: user.id },
      include: [{ model: Product, include: [Inventory] }],
      transaction: t,
    });
    if (!cartItems.length) {
      await t.rollback();
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Check + reserve stock inside the transaction to prevent overselling
    for (const item of cartItems) {
      const inv = item.Product.Inventory;
      if (!inv || inv.quantityInStock < item.quantity) {
        await t.rollback();
        return res.status(409).json({ error: `Insufficient stock for ${item.Product.name}` });
      }
    }

    const subtotal = cartItems.reduce((sum, i) => sum + Number(i.Product.price) * i.quantity, 0);
    const totalAmount = subtotal + Number(shippingCost);
    const orderNumber = generateOrderNumber();

    const order = await Order.create({
      orderNumber,
      UserId: user.id,
      subtotal,
      shippingCost,
      totalAmount,
      shippingAddress,
      shippingStreet: street || '',
      shippingArea: area || '',
      shippingCity: city,
      shippingRegion: region,
      paystackReference: orderNumber,
    }, { transaction: t });

    for (const item of cartItems) {
      await OrderItem.create({
        OrderId: order.id,
        ProductId: item.ProductId,
        quantity: item.quantity,
        unitPrice: item.Product.price,
        subtotal: Number(item.Product.price) * item.quantity,
      }, { transaction: t });

      const inv = item.Product.Inventory;
      inv.quantityInStock -= item.quantity;
      await inv.save({ transaction: t });
      await InventoryLog.create({
        ProductId: item.ProductId,
        action: 'sold',
        quantityChange: -item.quantity,
        referenceId: order.id,
      }, { transaction: t });
    }

    await OrderStatusHistory.create({ OrderId: order.id, status: 'pending' }, { transaction: t });
    await CartItem.destroy({ where: { UserId: user.id }, transaction: t });
    await t.commit();

    const payment = await paystack.initializeTransaction({
      email: user.email,
      amount: totalAmount,
      reference: orderNumber,
      metadata: { orderId: order.id, orderNumber },
    });

    res.status(201).json({ order, paymentUrl: payment.authorization_url });
  } catch (err) {
    if (!t.finished) await t.rollback();
    next(err);
  }
}

/**
 * POST /paystack/webhook — Paystack calls this on payment events.
 * Signature is verified against the raw request body.
 */
async function paystackWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];
  if (!paystack.isValidWebhookSignature(req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  res.sendStatus(200); // ack immediately; process after

  const event = req.body;
  try {
    if (event.event === 'charge.success') {
      const reference = event.data.reference;
      const order = await Order.findOne({ where: { paystackReference: reference }, include: [User] });
      if (!order || order.paymentStatus === 'completed') return;

      // Double-check with Paystack before marking paid
      const verified = await paystack.verifyTransaction(reference);
      if (verified.status !== 'success') return;

      order.status = 'pending_delivery';
      order.paymentStatus = 'completed';
      await order.save();
      await Payment.create({
        OrderId: order.id,
        amount: verified.amount / 100,
        currency: verified.currency,
        method: verified.channel,
        paystackReference: reference,
        status: 'success',
      });

      const history = await OrderStatusHistory.create({ OrderId: order.id, status: 'pending_delivery' });
      const smsResult = await sendSms(order.User.phoneNumber, 'order_confirmed', {
        name: order.User.firstName,
        orderNumber: order.orderNumber,
        amount: Number(order.totalAmount).toFixed(2),
      });
      if (smsResult) {
        history.smsSentAt = new Date();
        await history.save();
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
}

/**
 * GET /payments/verify?reference=... — called by the payment-complete page
 * after Paystack redirects back. Verifies with Paystack and updates the order.
 */
async function verifyByReference(req, res, next) {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'reference is required' });
    const order = await Order.findOne({
      where: { paystackReference: reference, UserId: req.user.id },
      include: [User],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.paymentStatus !== 'completed') {
      try {
        const verified = await paystack.verifyTransaction(reference);
        if (verified.status === 'success') {
          order.status = 'pending_delivery';
          order.paymentStatus = 'completed';
          await order.save();
          await Payment.findOrCreate({
            where: { paystackReference: reference, status: 'success' },
            defaults: {
              OrderId: order.id,
              amount: verified.amount / 100,
              currency: verified.currency,
              method: verified.channel,
            },
          });
          await OrderStatusHistory.create({ OrderId: order.id, status: 'pending_delivery' });
        }
      } catch {
        // verification unavailable — report current stored status
      }
    }
    res.json({
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      totalAmount: order.totalAmount,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /orders/:id/verify — client-side fallback after Paystack redirect. */
async function verifyPayment(req, res, next) {
  try {
    const order = await Order.findOne({ where: { id: req.params.id, UserId: req.user.id } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentStatus !== 'completed') {
      const verified = await paystack.verifyTransaction(order.paystackReference);
      if (verified.status === 'success') {
        order.status = 'pending_delivery';
        order.paymentStatus = 'completed';
        await order.save();
      }
    }
    res.json({ orderId: order.id, status: order.status, paymentStatus: order.paymentStatus });
  } catch (err) {
    next(err);
  }
}

const orderInclude = [{ model: OrderItem, include: [{ model: Product, include: [Brand] }] }];

async function listMyOrders(req, res, next) {
  try {
    const orders = await Order.findAll({
      where: { UserId: req.user.id },
      include: orderInclude,
      order: [['createdAt', 'DESC']],
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
}

async function getOrder(req, res, next) {
  try {
    const order = await Order.findOne({
      where: { id: req.params.id, UserId: req.user.id },
      include: orderInclude,
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
}

module.exports = { createOrder, paystackWebhook, verifyPayment, verifyByReference, listMyOrders, getOrder };
