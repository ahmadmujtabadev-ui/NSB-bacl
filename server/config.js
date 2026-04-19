import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  mongo: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/noorstudio',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceIds: {
      creator: process.env.STRIPE_PRICE_CREATOR || '',
      author:  process.env.STRIPE_PRICE_AUTHOR  || '',
      studio:  process.env.STRIPE_PRICE_STUDIO  || '',
    },
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  },

  ai: {
    textProvider: process.env.AI_TEXT_PROVIDER || 'mock',   
    imageProvider: process.env.AI_IMAGE_PROVIDER || 'mock', // 'bfl' | 'replicate' | 'gemini' | 'mock'
    maxRetries: parseInt(process.env.AI_MAX_RETRIES || '2', 10),
    timeoutMs: parseInt(process.env.API_TIMEOUT_MS || '60000', 10),

    keys: {
      claude: process.env.CLAUDE_API_KEY || '',
      bfl: process.env.BFL_API_KEY || '',
      replicate: process.env.REPLICATE_API_TOKEN || '',
      google: process.env.GOOGLE_API_KEY || '',
      nanobanana: process.env.NANOBANANA_API_KEY || '',
    },

    nanobanana: {
      apiUrl: process.env.NANOBANANA_API_URL || 'https://api.nanobanana.com/v1',
      model: process.env.NANOBANANA_MODEL || 'pixar-3d-v1',
    },

    railway: {
      publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || '',
      publicUrl: process.env.PUBLIC_URL || '',
    },
  },

  credits: {
    newUserBonus: parseInt(process.env.NEW_USER_CREDIT_BONUS || '50', 10),
  },
};
