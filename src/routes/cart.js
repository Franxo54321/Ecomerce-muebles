const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// Almacenamiento simple en memoria (en producción usarías una base de datos)
let cart = [];

// GET /api/cart - Obtener el carrito
router.get('/', (req, res) => {
  res.json(cart);
});

// POST /api/cart - Agregar producto al carrito
router.post('/', async (req, res) => {
  try {
    const { id, quantity = 1 } = req.body;
    
    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const existingItem = cart.find(item => item.id === id);
    
    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      cart.push({
        id: product._id,
        name: product.name,
        price: product.price,
        image: product.image,
        quantity: quantity
      });
    }
    
    res.json({ success: true, cart });
  } catch (error) {
    res.status(500).json({ error: 'Error al agregar al carrito' });
  }
});

// DELETE /api/cart/:id - Eliminar producto del carrito
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  const itemIndex = cart.findIndex(item => item.id === id);
  
  if (itemIndex === -1) {
    return res.status(404).json({ error: 'Producto no encontrado en el carrito' });
  }
  
  cart.splice(itemIndex, 1);
  res.json({ success: true, cart });
});

// PUT /api/cart/:id - Actualizar cantidad en el carrito
router.put('/:id', (req, res) => {
  const id = req.params.id;
  const { quantity } = req.body;
  const item = cart.find(item => item.id === id);
  
  if (!item) {
    return res.status(404).json({ error: 'Producto no encontrado en el carrito' });
  }
  
  if (quantity <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser mayor a 0' });
  }
  
  item.quantity = quantity;
  res.json({ success: true, cart });
});

module.exports = router;