const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const { MercadoPagoConfig, Preference } = require('mercadopago');

// Intentar require de multer, pero NO salir si falta (permitir fallback a Base64)
let multer;
try {
  multer = require('multer');
} catch (err) {
  console.warn('Advertencia: "multer" no está instalado. Usando fallback para recibir imágenes en Base64.');
  multer = null;
}

// Asegurar directorio de uploads
const uploadsDir = path.join(__dirname, 'img', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- NUEVO: Asegurar que exista img/default.png (placeholder) ---
const defaultImagePath = path.join(__dirname, 'img', 'default.png');
if (!fs.existsSync(defaultImagePath)) {
  try {
    // Pequeño PNG gris claro (1x1) en base64 (placeholder)
    const placeholderBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
    // Decodificar y escribir archivo
    fs.mkdirSync(path.join(__dirname, 'img'), { recursive: true });
    fs.writeFileSync(defaultImagePath, Buffer.from(placeholderBase64, 'base64'));
    console.log('Se creó placeholder img/default.png');
  } catch (err) {
    console.error('No se pudo crear placeholder default.png:', err);
  }
}

// Si multer está disponible, configurarlo
let upload = null;
if (multer) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\.-]/g, '');
      cb(null, `${Date.now()}-${safeName}`);
    }
  });
  upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // <-- subir a 10 MB
    fileFilter: (req, file, cb) => {
      if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  });
}

// Helper: guardar imagen Base64, devolver ruta pública (/img/uploads/...)
async function saveBase64Image(base64Data) {
  // Limite de bytes para imagen guardada
  const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

  // Manejo robusto: aceptar DataURL o cadena base64 pura
  let mime = 'image/png';
  let data = base64Data;

  if (typeof base64Data === 'string') {
    // Si contiene una coma y empieza con data:, partir y extraer mime
    if (base64Data.indexOf(',') !== -1 && base64Data.indexOf('data:') === 0) {
      const parts = base64Data.split(',');
      const meta = parts[0]; // e.g. data:image/jpeg;base64
      data = parts.slice(1).join(','); // todo lo que sigue
      const metaMatch = meta.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64/);
      if (metaMatch) mime = metaMatch[1];
    } else {
      // si no tiene prefijo, intentar detectar tipo por cabecera base64 (no fiable)
      // dejamos mime por defecto 'image/png' y usamos data tal cual
      data = base64Data;
    }
  } else {
    throw new Error('Formato de imagen inválido');
  }

  // Normalizar y limpiar espacios nuevos
  data = data.replace(/\s+/g, '');

  const buffer = Buffer.from(data, 'base64');

  if (buffer.length > MAX_BYTES) {
    const err = new Error('Imagen demasiado grande');
    err.code = 'LIMIT_FILE_SIZE';
    throw err;
  }

  // determinar extensión segura
  let ext = 'png';
  try {
    ext = (mime && mime.split('/')[1]) ? mime.split('/')[1].replace(/[^a-z0-9+]+/gi, '') : 'png';
    // normalizar jpeg/jpg
    if (ext === 'jpeg') ext = 'jpg';
  } catch (e) {
    ext = 'png';
  }

  const filename = `${Date.now()}-upload.${ext}`;

  // Si Cloudinary está configurado, subir ahí (persiste entre deploys)
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'plastimuebles', resource_type: 'image' },
        (error, result) => {
          if (error) { reject(error); return; }
          console.log('Imagen subida a Cloudinary:', result.secure_url);
          resolve(result.secure_url);
        }
      );
      const { Readable } = require('stream');
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);
      stream.pipe(uploadStream);
    });
  }

  // Fallback: guardar en disco local
  const filepath = path.join(uploadsDir, filename);
  await fs.promises.writeFile(filepath, buffer);
  console.log('Imagen guardada localmente en:', filepath);
  return `/img/uploads/${filename}`;
}

// Cargar .env o enviroment.env (local)
if (fs.existsSync(path.join(__dirname, '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} else {
  require('dotenv').config({ path: path.join(__dirname, 'enviroment.env') });
}

const app = express();
const PORT = process.env.PORT || 3000;

// --- CLOUDINARY (si las vars están presentes se usa para guardar imágenes) ---
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  console.log('Cloudinary configurado:', process.env.CLOUDINARY_CLOUD_NAME);
}

// --- EMAIL TRANSPORTER ---
function createEmailTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

// --- REGISTROS PENDIENTES (email -> { name, hashedPassword, code, expiresAt }) ---
// Se limpia automáticamente cada hora
const pendingRegistrations = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingRegistrations.entries()) {
    if (v.expiresAt < now) pendingRegistrations.delete(k);
  }
}, 60 * 60 * 1000);

// --- AUMENTAR LÍMITES DE BODY (necesario para Base64 grandes) ---
const JSON_LIMIT = process.env.JSON_LIMIT || '50mb';
app.use(cors());
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT }));

// Servir imágenes desde la carpeta img (coloca tus fotos en c:\Users\a\Desktop\pagina de muebles\img)
app.use('/img', express.static(path.join(__dirname, 'img')));

// Servir archivos estáticos (frontend) desde la raíz del proyecto
app.use(express.static(path.join(__dirname)));

// Ruta raíz para servir main2.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'main2.html'));
});

// Servir panel de administración en /admin (evita abrir archivo con file://)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel_Admin.html'));
});

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/plastimuebles', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Agregar listeners para visualizar el estado de la conexión a Mongo
mongoose.connection.on('connected', () => {
  console.log('MongoDB conectado:', mongoose.connection.host + ':' + mongoose.connection.port);
});
mongoose.connection.on('error', (err) => {
  console.error('MongoDB error:', err);
});
mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB desconectado');
});
mongoose.connection.on('reconnected', () => {
  console.log('MongoDB reconectado');
});

// Esquemas de MongoDB
const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true },
  image: { type: String, required: false }, // preservar por compatibilidad
  images: [String], // <-- nuevo: array de rutas
  stock: { type: Number, default: 0 },
  features: [String],
  dimensions: {
    height: Number,
    width: Number,
    depth: Number
  },
  colors: [String],
  material: { type: String, default: 'plástico' }
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  phone: String,
  role: { type: String, default: 'customer' },
  emailVerified: { type: Boolean, default: false }
}, { timestamps: true });

const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true }
  }],
  total: { type: Number, required: true },
  shippingAddress: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  paymentMethod: { type: String, default: 'credit card' },
  paymentStatus: { type: String, default: 'pending' },
  orderStatus: { type: String, default: 'processing' }
}, { timestamps: true });

const ContactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  message: { type: String, required: true },
  responded: { type: Boolean, default: false }
}, { timestamps: true });

// Modelos
const Product = mongoose.model('Product', ProductSchema);
const User = mongoose.model('User', UserSchema);
const Order = mongoose.model('Order', OrderSchema);
const Contact = mongoose.model('Contact', ContactSchema);
// Añadir modelo Cart para persistir el carrito por usuario
const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: Number,
    name: String,
    image: String
  }]
}, { timestamps: true });

const Cart = mongoose.model('Cart', CartSchema);

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acceso requerido' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

// Rutas de productos
app.get('/api/products', async (req, res) => {
  try {
    const { category } = req.query;
    let filter = {};
    
    if (category && category !== 'all') {
      filter.category = category;
    }
    
    const products = await Product.find(filter);
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener el producto' });
  }
});

// --- Registrar ruta /api/products con dos maneras ---
// Si multer está disponible, registramos la ruta multipart
if (upload) {
  app.post('/api/products', upload.single('image'), async (req, res) => {
    try {
      const { name, price, category, description } = req.body;
      if (!name || !price || !category) {
        return res.status(400).json({ error: 'Faltan campos obligatorios: name, price o category' });
      }

      let imagePath = '';
      if (req.file) imagePath = `/img/uploads/${req.file.filename}`;

      const product = new Product({
        name,
        price: parseFloat(price),
        description: description || '',
        category,
        image: imagePath,
        stock: req.body.stock ? parseInt(req.body.stock, 10) : 0
      });

      await product.save();
      res.status(201).json({ success: true, product });
    } catch (err) {
      console.error('Error creando producto (multipart):', err);
      res.status(500).json({ error: 'Error al crear el producto', details: err.message });
    }
  });
} 

// Ruta alternativa que acepta JSON con field imageBase64 (funciona sin multer)
app.post('/api/products', async (req, res) => {
  try {
    const { name, price, category, description, imageBase64, imageUrl, imageBase64s, colors } = req.body;
    if (!name || !price || !category) {
      return res.status(400).json({ error: 'Faltan campos obligatorios: name, price o category' });
    }

    let imagePath = '';
    const imagePaths = [];

    // soportar tanto imageBase64 (string) como imageBase64s (array)
    if (Array.isArray(imageBase64s) && imageBase64s.length > 0) {
      for (const b64 of imageBase64s) {
        try {
          const p = await saveBase64Image(b64);
          imagePaths.push(p);
        } catch (err) {
          console.error('Error guardando imagen Base64 (array):', err);
        }
      }
    } else if (imageBase64) {
      // única imagen base64
      try {
        imagePath = await saveBase64Image(imageBase64);
      } catch (err) {
        console.error('Error guardando imagen Base64:', err);
        return res.status(500).json({ error: 'Error al guardar la imagen' });
      }
    } else if (imageUrl) {
      imagePath = imageUrl;
    } else {
      imagePath = '/img/default.png';
    }

    // procesar colors: puede venir como array o como string "rojo,azul"
    let colorsArr = [];
    if (Array.isArray(colors)) {
      colorsArr = colors.map(c => String(c).trim()).filter(Boolean);
    } else if (typeof colors === 'string' && colors.trim()) {
      colorsArr = colors.split(',').map(s => s.trim()).filter(Boolean);
    }

    const product = new Product({
      name,
      price: parseFloat(price),
      description: description || '',
      category,
      image: imagePath || (imagePaths[0] || ''),
      images: imagePaths.length ? imagePaths : (imagePath ? [imagePath] : []),
      stock: req.body.stock ? parseInt(req.body.stock, 10) : 0,
      colors: colorsArr
    });

    // Si hay images guardadas y image aún no establecida, asegurar image principal
    if ((!product.image || product.image === '') && product.images && product.images.length) {
      product.image = product.images[0];
    }

    await product.save();
    res.status(201).json({ success: true, product });
  } catch (err) {
    console.error('Error creando producto (json/base64):', err);
    res.status(500).json({ error: 'Error al crear el producto', details: err.message });
  }
});

// Rutas de autenticación
// PASO 1: Registrar → guarda pendiente y envía código al email
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    // Verificar si el usuario ya existe y está verificado
    const existingUser = await User.findOne({ email });
    if (existingUser && existingUser.emailVerified) {
      return res.status(400).json({ error: 'El correo ya está registrado' });
    }
    // Si existe pero no verificado, eliminarlo para permitir reenvío
    if (existingUser && !existingUser.emailVerified) {
      await User.deleteOne({ email });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Generar código de 6 dígitos
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutos

    pendingRegistrations.set(email, { name, hashedPassword, code, expiresAt });

    // Intentar enviar email con código
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        const transporter = createEmailTransporter();
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || `UrbanPlast <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Código de verificación - UrbanPlast',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
              <h2 style="color:#4A7B3F">UrbanPlast - Verificación de correo</h2>
              <p>Hola <strong>${name}</strong>,</p>
              <p>Usa este código para verificar tu cuenta:</p>
              <div style="font-size:36px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f4f6f8;border-radius:8px;margin:16px 0">${code}</div>
              <p style="color:#888;font-size:13px">Este código expira en 15 minutos. Si no solicitaste esto, ignora este mensaje.</p>
            </div>
          `
        });
        console.log('Código de verificación enviado a:', email);
      } catch (emailErr) {
        console.error('Error enviando email de verificación:', emailErr.message);
        // No fallar el registro si el email falla - devolver código en modo dev
        if (process.env.NODE_ENV !== 'production') {
          return res.status(201).json({
            needsVerification: true,
            devCode: code, // solo en desarrollo
            message: 'Advertencia: no se pudo enviar el email. Código de desarrollo incluido.'
          });
        }
        return res.status(500).json({ error: 'No se pudo enviar el correo de verificación. Verifica EMAIL_USER y EMAIL_PASS.' });
      }
    } else {
      // Sin credenciales de email: devolver código en consola y body (solo desarrollo)
      console.log(`[DEV] Código de verificación para ${email}: ${code}`);
      return res.status(201).json({
        needsVerification: true,
        devCode: code,
        message: 'Configura EMAIL_USER y EMAIL_PASS para recibir el código por correo. Por ahora está disponible en esta respuesta (solo desarrollo).'
      });
    }

    res.status(201).json({
      needsVerification: true,
      message: `Se envió un código de verificación a ${email}. Revisa tu bandeja de entrada.`
    });
  } catch (error) {
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ error: 'Error al registrar usuario', details: error.message });
  }
});

// PASO 2: Verificar código → crea la cuenta y devuelve token
app.post('/api/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email y código son requeridos' });
    }

    const pending = pendingRegistrations.get(email);
    if (!pending) {
      return res.status(400).json({ error: 'No hay un registro pendiente para ese correo. Vuelve a registrarte.' });
    }
    if (Date.now() > pending.expiresAt) {
      pendingRegistrations.delete(email);
      return res.status(400).json({ error: 'El código expiró. Vuelve a registrarte.' });
    }
    if (pending.code !== String(code).trim()) {
      return res.status(400).json({ error: 'Código incorrecto. Intenta de nuevo.' });
    }

    // Código correcto: crear usuario verificado
    pendingRegistrations.delete(email);
    const newUser = new User({
      name: pending.name,
      email,
      password: pending.hashedPassword,
      emailVerified: true
    });
    await newUser.save();

    const token = jwt.sign(
      { userId: newUser._id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Cuenta verificada y creada exitosamente',
      token,
      user: { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role }
    });
  } catch (error) {
    console.error('Error al verificar email:', error);
    res.status(500).json({ error: 'Error al verificar el código', details: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    // Bloquear login si el email no está verificado
    if (!user.emailVerified) {
      return res.status(403).json({
        error: 'Debes verificar tu correo antes de iniciar sesión.',
        needsVerification: true,
        email
      });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Inicio de sesión exitoso',
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Nuevo endpoint para obtener perfil del usuario (usa JWT)
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener perfil' });
  }
});

// Rutas del carrito (ahora persisten en la colección carts)
app.get('/api/cart', authenticateToken, async (req, res) => {
  try {
    const cart = await Cart.findOne({ userId: req.user.userId });
    res.json(cart ? cart.items : []);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener el carrito' });
  }
});

app.post('/api/cart', authenticateToken, async (req, res) => {
  try {
    const { productId, quantity } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

    let cart = await Cart.findOne({ userId: req.user.userId });
    if (!cart) {
      cart = new Cart({ userId: req.user.userId, items: [] });
    }

    const idx = cart.items.findIndex(i => i.productId.toString() === productId);
    if (idx > -1) {
      cart.items[idx].quantity += quantity;
    } else {
      cart.items.push({
        productId: product._id,
        quantity,
        price: product.price,
        name: product.name,
        image: product.image
      });
    }

    await cart.save();
    res.json({ success: true, cart: cart.items });
  } catch (error) {
    console.error('Error al agregar al carrito:', error);
    res.status(500).json({ error: 'Error al agregar al carrito' });
  }
});

app.delete('/api/cart/:productId', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const cart = await Cart.findOne({ userId: req.user.userId });
    if (!cart) return res.json({ success: true, cart: [] });

    cart.items = cart.items.filter(item => item.productId.toString() !== productId);
    await cart.save();
    res.json({ success: true, cart: cart.items });
  } catch (error) {
    console.error('Error al eliminar del carrito:', error);
    res.status(500).json({ error: 'Error al eliminar del carrito' });
  }
});

// Ruta para contacto
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    
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

// Ruta para checkout (legacy, mantener por compatibilidad)
app.post('/api/checkout', authenticateToken, async (req, res) => {
  try {
    const { cart, shippingAddress, paymentMethod } = req.body;
    
    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }
    
    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    const order = new Order({
      userId: req.user.userId,
      items: cart.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price
      })),
      total,
      shippingAddress,
      paymentMethod
    });
    
    await order.save();

    // Limpiar carrito en DB
    await Cart.findOneAndUpdate({ userId: req.user.userId }, { items: [] });
    
    res.json({ 
      success: true, 
      message: 'Orden creada exitosamente',
      orderId: order._id
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar la orden' });
  }
});

// =============================================
// MERCADOPAGO - Crear preferencia de pago
// =============================================
app.post('/api/create-preference', authenticateToken, async (req, res) => {
  try {
    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'MercadoPago no está configurado. Agrega MP_ACCESS_TOKEN en las variables de entorno.' });
    }

    const { cart, shippingAddress } = req.body;
    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío' });
    }

    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // Crear orden en DB con estado pendiente
    const order = new Order({
      userId: req.user.userId,
      items: cart.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price
      })),
      total,
      shippingAddress,
      paymentMethod: 'mercadopago',
      paymentStatus: 'pending',
      orderStatus: 'awaiting_payment'
    });
    await order.save();

    // Configurar MercadoPago
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(mpClient);
    
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    
    const preferenceData = await preference.create({
      body: {
        items: cart.map(item => ({
          title: item.name || 'Producto',
          quantity: item.quantity,
          unit_price: Number(item.price),
          currency_id: 'ARS'
        })),
        back_urls: {
          success: `${appUrl}/payment-result.html?status=success&order=${order._id}`,
          failure: `${appUrl}/payment-result.html?status=failure&order=${order._id}`,
          pending: `${appUrl}/payment-result.html?status=pending&order=${order._id}`
        },
        auto_return: 'approved',
        external_reference: order._id.toString(),
        notification_url: `${appUrl}/api/webhooks/mercadopago`
      }
    });

    console.log('MercadoPago preferencia creada:', preferenceData.id);

    res.json({
      init_point: preferenceData.init_point,
      preference_id: preferenceData.id,
      orderId: order._id
    });
  } catch (error) {
    console.error('Error creando preferencia MercadoPago:', error);
    res.status(500).json({ error: 'Error al crear el pago', details: error.message });
  }
});

// Webhook de MercadoPago (recibe notificaciones de pago)
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('MercadoPago webhook:', type, data);

    if (type === 'payment') {
      const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
      // Obtener info del pago
      const paymentResponse = await fetch(
        `https://api.mercadopago.com/v1/payments/${data.id}`,
        { headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` } }
      );
      const payment = await paymentResponse.json();

      if (payment.external_reference) {
        const order = await Order.findById(payment.external_reference);
        if (order) {
          if (payment.status === 'approved') {
            order.paymentStatus = 'paid';
            order.orderStatus = 'processing';
          } else if (payment.status === 'pending' || payment.status === 'in_process') {
            order.paymentStatus = 'pending';
          } else {
            order.paymentStatus = 'failed';
            order.orderStatus = 'cancelled';
          }
          await order.save();
          console.log(`Orden ${order._id} actualizada: pago ${payment.status}`);

          // Limpiar carrito del usuario
          if (payment.status === 'approved') {
            await Cart.findOneAndUpdate({ userId: order.userId }, { items: [] });
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error en webhook MercadoPago:', error);
    res.sendStatus(200); // Siempre responder 200 para evitar reintentos
  }
});

// Consultar estado de una orden
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (order.userId.toString() !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    res.json(order);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener la orden' });
  }
});

// Ruta para poblar la base de datos con productos de ejemplo
app.post('/api/populate-products', async (req, res) => {
  console.log('POST /api/populate-products llamado desde', req.ip || req.headers['x-forwarded-for'] || 'unknown');
  try {
    const existingCount = await Product.countDocuments({});
    const force = String(req.query.force || '').toLowerCase() === 'true';

    if (existingCount > 0 && !force) {
      console.log(`populate-products: DB ya contiene ${existingCount} productos. No se sobrescribirá sin ?force=true`);
      return res.json({ success: false, message: 'La base de datos ya contiene productos. Usa ?force=true para sobrescribir.' });
    }

    // Si force=true o DB vacía, procedemos a repoblar
    await Product.deleteMany({});

    const sampleProducts = [
      {
        name: "Silla Estefany",
        price: 25.99,
        description: "Silla resistente para exterior, ideal para jardín o terraza.",
        category: "exterior",
        image: "img/upscaled/silla_estefany.png",
        stock: 50,
        features: ["Resistente a la intemperie", "Fácil de limpiar", "Apilable"],
        dimensions: { height: 85, width: 45, depth: 50 },
        colors: ["Azul", "Verde", "Blanco"],
        material: "Polipropileno"
      },
      {
        name: "Silla París",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "exterior",
        image: "img/upscaled/silla_paris.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
       {
        
        name: "Silla Colonial",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "exterior",
        image: "img/upscaled/silla_colonial.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
       {
        
        name: "Silla Eames",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "interior",
        image: "img/upscaled/silla_eames.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
      {

        name: "Silla Carolina",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "interior",
        image: "img/upscaled/silla_carolina.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
      {
        
        name: "Silla Eames",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "interior",
        image: "img/upscaled/silla_eames.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
      {
        
        name: "Silla Eames",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "interior",
        image: "img/upscaled/silla_eames.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
      {
        
        name: "Silla Eames",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "interior",
        image: "img/upscaled/silla_eames.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
      {
        
        name: "Silla Eames",
        price: 45.50,
        description: "Mesa práctica y funcional, fácil de almacenar cuando no se usa.",
        category: "interior",
        image: "img/upscaled/silla_eames.png", // La imagen debe estar en c:\Users\a\Desktop\pagina de muebles\img\mesa-plegable.png
        stock: 30,
        features: ["Plegable", "Liviana", "Surface resistente"],
        dimensions: { height: 72, width: 120, depth: 60 },
        colors: ["Negro", "Blanco", "Marrón"],
        material: "Plástico reforzado"
      },
      
    ];
    
    await Product.insertMany(sampleProducts);
    
    console.log('Productos insertados:', sampleProducts.length);
    res.json({ success: true, message: 'Productos agregados correctamente' });
  } catch (error) {
    console.error('Error en populate-products:', error);
    res.status(500).json({ error: 'Error al poblar la base de datos' });
  }
});

// Ruta de salud / ping
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Reemplazar app.listen(...) por lógica que maneje EADDRINUSE y reintente en otros puertos
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_PORT_ATTEMPTS = 5;

// Añadir variable para la instancia del servidor y bandera de apagado
let serverInstance = null;
let shuttingDown = false;

function startServer(port, attemptsLeft) {
  serverInstance = app.listen(port)
    .on('listening', () => {
      console.log(`Servidor escuchando en http://localhost:${port}`);
      console.log('PID del proceso:', process.pid);
      console.log('Estado de conexión MongoDB (readyState):', mongoose.connection.readyState);
    })
    .on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`Error: puerto ${port} en uso (EADDRINUSE).`);
        if (attemptsLeft > 0) {
          const nextPort = port + 1;
          console.log(`Intentando puerto ${nextPort} (quedan ${attemptsLeft - 1} intentos)...`);
          setTimeout(() => startServer(nextPort, attemptsLeft - 1), 500);
        } else {
          console.error('No se pudo iniciar el servidor — todos los puertos intentados están en uso.');
          console.error('Opciones: liberar el puerto con netstat/taskkill o cambiar PORT en enviroment.env.');
          process.exit(1);
        }
      } else {
        console.error('Error al iniciar el servidor:', err);
        process.exit(1);
      }
    });
}

// Mejora de shutdown: cierra server, cierra mongoose y fuerza salida tras timeout
function shutdown(reason) {
  if (shuttingDown) {
    console.log('Shutdown ya en curso, ignorando llamada adicional.');
    return;
  }
  shuttingDown = true;
  console.log('Iniciando cierre del servidor. Motivo:', reason || 'signal recibido');

  const FORCE_EXIT_TIMEOUT_MS = 5000;
  const forceExitTimer = setTimeout(() => {
    console.error(`Forzando salida después de ${FORCE_EXIT_TIMEOUT_MS} ms.`);
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);

  const closeMongoose = async (exitCode) => {
    try {
      await mongoose.connection.close();
      console.log('Conexión a MongoDB cerrada.');
    } catch (e) {
      console.error('Error cerrando MongoDB:', e.message);
    }
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  };

  if (serverInstance) {
    serverInstance.close((err) => {
      if (err) console.error('Error cerrando el servidor HTTP:', err);
      else console.log('Servidor HTTP cerrado.');
      closeMongoose(err ? 1 : 0);
    });
  } else {
    closeMongoose(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  shutdown('unhandledRejection');
});

// --- SEED: crear usuario admin si ADMIN_EMAIL y ADMIN_PASSWORD están definidos ---
async function seedAdminUser() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return;
  try {
    const existing = await User.findOne({ email: adminEmail });
    if (existing) {
      // Asegurarse de que sea admin verificado
      if (existing.role !== 'admin' || !existing.emailVerified) {
        existing.role = 'admin';
        existing.emailVerified = true;
        await existing.save();
        console.log('Admin actualizado:', adminEmail);
      }
      return;
    }
    const hashed = await bcrypt.hash(adminPassword, 10);
    await User.create({ name: 'Admin', email: adminEmail, password: hashed, role: 'admin', emailVerified: true });
    console.log('Usuario admin creado:', adminEmail);
  } catch (err) {
    console.error('Error al crear admin seed:', err.message);
  }
}

mongoose.connection.once('connected', () => {
  seedAdminUser();
});

startServer(DEFAULT_PORT, MAX_PORT_ATTEMPTS);

// Si multer está disponible, exponer PUT multipart para subir archivos directos
if (upload) {
  app.put('/api/products/:id/images', upload.array('images', 10), async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

      const savedPaths = [];
      if (req.files && req.files.length) {
        for (const f of req.files) {
          // f.filename ya fue generado por multer.diskStorage
          savedPaths.push(`/img/uploads/${f.filename}`);
        }
      }

      const replace = req.body.replace === 'true' || req.body.replace === true;

      if (replace) {
        product.images = savedPaths;
        product.image = savedPaths[0] || product.image;
      } else {
        product.images = (product.images || []).concat(savedPaths);
        if (!product.image && product.images.length) product.image = product.images[0];
      }

      await product.save();
      res.json({ success: true, product });
    } catch (err) {
      console.error('Error multipart PUT images:', err);
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Imagen demasiado grande' });
      res.status(500).json({ error: 'Error al actualizar imágenes', details: err.message });
    }
  });
}

// PUT en JSON (acepta imageBase64s array y/o imageUrls array)
// Asegurar que al agregar imágenes se actualice product.images y se fije product.image = product.images[0]
app.put('/api/products/:id/images', async (req, res) => {
  try {
    const { imageBase64s, imageUrls, replace } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

    const newPaths = [];

    if (Array.isArray(imageBase64s) && imageBase64s.length > 0) {
      for (const b64 of imageBase64s) {
        try {
          const p = await saveBase64Image(b64);
          newPaths.push(p);
        } catch (err) {
          console.error('Error guardando imagen Base64 en PUT:', err);
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Al menos una imagen excede el límite permitido.' });
          }
        }
      }
    }

    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      for (const u of imageUrls) {
        if (typeof u === 'string' && u.trim()) newPaths.push(u);
      }
    }

    if (replace) {
      product.images = newPaths;
    } else {
      product.images = (product.images || []).concat(newPaths);
    }

    // Siempre actualizar image principal si hay imágenes disponibles
    if (product.images && product.images.length > 0) {
      product.image = product.images[0];
    }

    await product.save();
    res.json({ success: true, product });
  } catch (err) {
    console.error('Error PUT images JSON:', err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Imagen demasiado grande' });
    res.status(500).json({ error: 'Error al actualizar imágenes', details: err.message });
  }
});