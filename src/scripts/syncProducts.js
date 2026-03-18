const mysql = require('mysql2');
const mongoose = require('mongoose');
const Product = require('../models/Product');
require('dotenv').config({ path: '../../.env' });

// Configurar conexiones
const sqlConnection = mysql.createConnection({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'muebles_db'
});

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/plastimuebles', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function syncProducts() {
  console.log('Iniciando sincronización de productos...');
  
  // Obtener productos de MySQL
  const sqlQuery = 'SELECT * FROM muebles';
  
  sqlConnection.query(sqlQuery, async (err, results) => {
    if (err) {
      console.error('Error en consulta MySQL:', err);
      process.exit(1);
    }
    
    console.log(`Encontrados ${results.length} productos en MySQL`);
    
    let migrated = 0;
    let errors = 0;
    
    for (const row of results) {
      try {
        // Verificar si ya existe en MongoDB
        const existingProduct = await Product.findOne({ mysql_id: row.id });
        
        if (!existingProduct) {
          // Crear nuevo producto en MongoDB
          const newProduct = new Product({
            mysql_id: row.id,
            name: row.nombre,
            price: parseFloat(row.precio),
            description: row.descripcion || '',
            category: row.categoria || 'general',
            image: row.imagen_url || '',
            stock: row.stock || 0
          });
          
          await newProduct.save();
          migrated++;
          console.log(`Migrado: ${row.nombre}`);
        }
      } catch (error) {
        console.error(`Error migrando producto ${row.nombre}:`, error.message);
        errors++;
      }
    }
    
    console.log(`Sincronización completada. Migrados: ${migrated}, Errores: ${errors}`);
    process.exit(0);
  });
}

// Ejecutar solo si se llama directamente
if (require.main === module) {
  syncProducts();
}

module.exports = syncProducts;