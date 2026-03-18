const express = require('express');
const router = express.Router();
const Contact = require('../models/Contact');

// POST /api/contact - Enviar mensaje de contacto
router.post('/', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    
    // Validación simple
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    const newContact = new Contact({
      name,
      email,
      message
    });
    
    await newContact.save();
    
    // Aquí podrías agregar el envío de un email de notificación
    
    res.json({ success: true, message: 'Mensaje recibido correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al enviar el mensaje' });
  }
});

module.exports = router;