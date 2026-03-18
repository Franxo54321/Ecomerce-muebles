const express = require('express');
const router = express.Router();

// Almacenamiento simple de órdenes en memoria (en producción usarías la base de datos)
let orders = [];
let orderIdCounter = 1;

// POST /api/orders - Crear una nueva orden
router.post('/', async (req, res) => {
  try {
    const { items, shippingAddress, paymentMethod } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }
    
    // Calcular total
    const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    // Crear orden
    const order = {
      id: orderIdCounter++,
      items: items.map(item => ({
        productId: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      total,
      shippingAddress,
      paymentMethod,
      status: 'completed',
      createdAt: new Date()
    };
    
    orders.push(order);
    
    res.json({ 
      success: true, 
      message: 'Orden creada exitosamente',
      orderId: order.id
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar la orden' });
  }
});

// GET /api/orders - Obtener órdenes
router.get('/', (req, res) => {
  try {
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener las órdenes' });
  }
});

module.exports = router;