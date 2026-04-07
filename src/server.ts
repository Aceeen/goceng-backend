import app from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';

const startServer = async () => {
  try {
    // Attempt to connect to the database (just a ping query)
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Connected to Database (Supabase)');

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 Server is running on http://localhost:${env.PORT}`);
      console.log(`🌍 Environment: ${env.NODE_ENV}`);
    });

    // Graceful Shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM signal received. Closing HTTP server');
      server.close(async () => {
        console.log('HTTP server closed');
        await prisma.$disconnect();
        process.exit(0);
      });
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
