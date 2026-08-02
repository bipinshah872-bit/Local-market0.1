import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { INITIAL_LISTINGS, INITIAL_USERS, INITIAL_CAMPAIGNS } from './src/data/initialData.js';
import { maskEmail } from './src/utils/masking.js';
import { Listing, User } from './src/types.js';

dotenv.config();

const app = express();
const PORT = 3000;

// In-memory persistent database for dev runtime
let listings: Listing[] = [...INITIAL_LISTINGS];
let users: User[] = [...INITIAL_USERS];
let campaigns = [...INITIAL_CAMPAIGNS];
let messages: any[] = [
  {
    id: 'msg_1',
    listingId: 'list_1',
    listingTitle: 'Apple MacBook Pro M2',
    senderId: 'user_buyer_1',
    senderName: 'Ananya Roy',
    senderMaskedEmail: maskEmail('ananya.buyer@localmarket.com'),
    receiverId: 'user_seller_1',
    receiverName: 'Priya Sharma',
    text: 'Hi Priya, is this MacBook Pro M2 still available in Bandra West? Can I inspect it today?',
    timestamp: new Date(Date.now() - 3600000 * 4).toISOString()
  },
  {
    id: 'msg_2',
    listingId: 'list_1',
    listingTitle: 'Apple MacBook Pro M2',
    senderId: 'user_seller_1',
    senderName: 'Priya Sharma',
    senderMaskedEmail: maskEmail('priya.sharma@localmarket.com'),
    receiverId: 'user_buyer_1',
    receiverName: 'Ananya Roy',
    text: 'Hello Ananya! Yes, it is available. You can visit near Bandra Station between 4 PM and 7 PM.',
    timestamp: new Date(Date.now() - 3600000 * 2).toISOString()
  }
];

// Initialize Gemini SDK lazily / safely
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    try {
      aiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });
    } catch (err) {
      console.warn('Gemini client initialization warning:', err);
    }
  }
  return aiClient;
}

// Global Body Parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security Header / Response Content-Type helper
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

// API Routes
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET Listings
app.get('/api/listings', (req: Request, res: Response) => {
  try {
    const { category, search, neighborhood, condition, minPrice, maxPrice, status } = req.query;
    let filtered = [...listings];

    if (category && category !== 'All Categories') {
      filtered = filtered.filter(l => l.category === category);
    }

    if (neighborhood && neighborhood !== 'All Neighborhoods') {
      filtered = filtered.filter(l => l.location === neighborhood);
    }

    if (condition && condition !== 'Any Condition') {
      filtered = filtered.filter(l => l.condition === condition);
    }

    if (status) {
      filtered = filtered.filter(l => l.status === status);
    }

    if (minPrice) {
      const min = Number(minPrice);
      if (!isNaN(min)) filtered = filtered.filter(l => l.priceUSD >= min);
    }

    if (maxPrice) {
      const max = Number(maxPrice);
      if (!isNaN(max)) filtered = filtered.filter(l => l.priceUSD <= max);
    }

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.toLowerCase().trim();
      filtered = filtered.filter(l => 
        l.title.toLowerCase().includes(q) || 
        l.description.toLowerCase().includes(q) ||
        l.location.toLowerCase().includes(q) ||
        l.category.toLowerCase().includes(q)
      );
    }

    res.json({ success: true, count: filtered.length, listings: filtered });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Server error fetching listings' });
  }
});

// POST New Listing
app.post('/api/listings', (req: Request, res: Response) => {
  try {
    const { title, description, priceUSD, category, condition, location, imageUrl, sellerId, sellerName, sellerEmail, sellerPhone } = req.body;

    if (!title || !priceUSD || !category) {
      return res.status(400).json({ success: false, error: 'Missing required fields: title, priceUSD, and category.' });
    }

    const sellerEmailMasked = maskEmail(sellerEmail || 'seller@localmarket.com');

    const newListing: Listing = {
      id: `list_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      title: title.trim(),
      description: (description || 'No description provided. Contact seller for details.').trim(),
      priceUSD: Number(priceUSD) || 10,
      category: category || 'Electronics',
      condition: condition || 'Used - Good',
      location: location || 'Indiranagar',
      imageUrl: imageUrl || 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&q=80&w=800',
      sellerId: sellerId || 'user_seller_1',
      sellerName: sellerName || 'Verified Seller',
      sellerMaskedEmail: sellerEmailMasked,
      sellerAvatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=250',
      sellerVerified: true,
      sellerPhone: sellerPhone || '+91 98000 00000',
      status: 'available',
      isFeatured: false,
      viewsCount: 1,
      createdAt: new Date().toISOString()
    };

    listings.unshift(newListing);
    res.status(201).json({ success: true, listing: newListing });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Failed to create listing' });
  }
});

// PUT Update Listing / Feature / Mark Sold
app.put('/api/listings/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const index = listings.findIndex(l => l.id === id);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    listings[index] = { ...listings[index], ...req.body };
    res.json({ success: true, listing: listings[index] });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Failed to update listing' });
  }
});

// DELETE Listing
app.delete('/api/listings/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    listings = listings.filter(l => l.id !== id);
    res.json({ success: true, message: 'Listing deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Failed to delete listing' });
  }
});

// Gemini AI Listing Helper API
app.post('/api/gemini/suggest-listing', async (req: Request, res: Response) => {
  try {
    const { title, category, condition } = req.body;
    if (!title) {
      return res.status(400).json({ success: false, error: 'Item title is required for AI suggestions.' });
    }

    const ai = getGeminiClient();
    if (!ai) {
      // Fallback response if GEMINI_API_KEY is not configured
      return res.json({
        success: true,
        suggestedTitle: `${title} - Excellent Local Deal`,
        suggestedDescription: `Premium ${condition || 'pre-owned'} ${title} available in your neighborhood. Well-maintained, tested, and ready for pickup or local delivery.`,
        suggestedPriceUSD: 75,
        aiGenerated: false
      });
    }

    const prompt = `You are an expert AI Assistant for "Local Market", a neighborhood buying and selling marketplace.
Given the item title: "${title}", category: "${category || 'General'}", condition: "${condition || 'Used - Good'}".
Suggest:
1. A clear, high-converting product title (max 70 chars)
2. An engaging 2-3 sentence seller description highlighting key features, value, and local pickup convenience.
3. An estimated fair market price in USD (number only).

Return purely a JSON object in this format:
{
  "suggestedTitle": "...",
  "suggestedDescription": "...",
  "suggestedPriceUSD": 85
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const responseText = response.text || '';
    let parsedData = {};
    try {
      parsedData = JSON.parse(responseText);
    } catch (e) {
      parsedData = {
        suggestedTitle: title,
        suggestedDescription: `${title} in ${condition || 'good'} condition. Available for local pickup or fast delivery.`,
        suggestedPriceUSD: 50
      };
    }

    res.json({ success: true, ...parsedData, aiGenerated: true });
  } catch (error: any) {
    console.error('Gemini suggest error:', error);
    res.json({
      success: true,
      suggestedTitle: req.body.title || 'Item for Sale',
      suggestedDescription: `Well maintained ${req.body.title || 'item'} available for pickup in neighborhood.`,
      suggestedPriceUSD: 50,
      aiGenerated: false
    });
  }
});

// Authentication Endpoint (Always returns masked emails)
app.post('/api/auth/login', (req: Request, res: Response) => {
  try {
    const { email, password, demoType } = req.body;

    let targetUser: User | undefined;

    if (demoType) {
      if (demoType === 'owner') {
        targetUser = users.find(u => u.role === 'owner');
      } else if (demoType === 'seller') {
        targetUser = users.find(u => u.role === 'seller');
      } else {
        targetUser = users.find(u => u.role === 'buyer');
      }
    } else if (email) {
      targetUser = users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());
      if (!targetUser) {
        // Create new user session
        const namePart = email.split('@')[0];
        const formattedName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
        targetUser = {
          id: `usr_${Date.now()}`,
          name: formattedName || 'Local Member',
          email: email.trim(),
          maskedEmail: maskEmail(email.trim()),
          role: email.includes('owner') || email.includes('admin') ? 'owner' : 'seller',
          isVerified: true,
          avatar: `https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=250`,
          neighborhood: 'Bandra West',
          rating: 5.0,
          joinedDate: 'Aug 2026'
        };
        users.push(targetUser);
      }
    }

    if (!targetUser) {
      targetUser = users[0];
    }

    // Ensure email in response is safely masked
    const safeUser = {
      ...targetUser,
      maskedEmail: maskEmail(targetUser.email)
    };

    res.json({ success: true, user: safeUser });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Auth failed' });
  }
});

// Messages API
app.get('/api/messages', (req: Request, res: Response) => {
  const { userId } = req.query;
  let userMsgs = [...messages];
  if (userId) {
    userMsgs = userMsgs.filter(m => m.senderId === userId || m.receiverId === userId);
  }
  res.json({ success: true, messages: userMsgs });
});

app.post('/api/messages', (req: Request, res: Response) => {
  try {
    const { listingId, listingTitle, senderId, senderName, senderEmail, receiverId, receiverName, text } = req.body;
    const newMsg = {
      id: `msg_${Date.now()}`,
      listingId: listingId || 'list_1',
      listingTitle: listingTitle || 'Listing',
      senderId: senderId || 'user_buyer_1',
      senderName: senderName || 'Local Buyer',
      senderMaskedEmail: maskEmail(senderEmail || 'buyer@localmarket.com'),
      receiverId: receiverId || 'user_seller_1',
      receiverName: receiverName || 'Seller',
      text: text || 'Interested in this item!',
      timestamp: new Date().toISOString()
    };
    messages.push(newMsg);
    res.status(201).json({ success: true, message: newMsg });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// Express Error Handler for API routes
app.use('/api', (err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('API Error:', err);
  res.status(500).json({ success: false, error: err?.message || 'Internal Server Error' });
});

// Vite Middleware for Dev or Static files in Production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Local Market server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
