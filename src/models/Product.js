const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  image: {
    type: String,
    required: true
  },
  stock: {
    type: Number,
    default: 0,
    min: 0
  },
  features: [{
    type: String
  }],
  dimensions: {
    height: Number,
    width: Number,
    depth: Number
  },
  colors: [{
    type: String
  }],
  material: {
    type: String,
    default: 'plástico'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Product', productSchema);