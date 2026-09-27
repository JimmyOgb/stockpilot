import React, { useState, useCallback } from 'react';
import { Navbar } from './components/Navbar.js';
import { MobileMenu } from './components/MobileMenu.js';
import { CinematicHero } from './components/CinematicHero.js';
import { CommandCenter } from './components/CommandCenter.js';
import { StatusModal } from './components/StatusModal.js';
import { WalletModal } from './components/WalletModal.js';
import { useVideoScrub } from './hooks/useVideoScrub.js';
import { useWallet } from './hooks/useWallet.js';

export const VIDEO_URL =
  'https://d8j0ntlcm91z4cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260821_114821_a8ca298f-be2c-4613-a4dd-51b69e16bbde.mp4';

export const App: React.FC = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [statusModalOpen, setStatusModalOpen] = useState<boolean>(false);
  const [walletModalOpen, setWalletModalOpen] = useState<boolean>(false);
  const [activeItem, setActiveItem] = useState<string>('STOCKPILOT');

  const wallet = useWallet();

  const {
    containerRef,
    videoRef,
    canvasRef,
    scrollProgress,
    canvasLive
  } = useVideoScrub({ videoSrc: VIDEO_URL });

  const scrollToSection = useCallback((sectionId: string) => {
    setActiveItem(sectionId.toUpperCase());
    const el = document.getElementById(sectionId);
    if (el) {
      const rect = el.getBoundingClientRect();
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const targetY = rect.top + scrollTop - 100;
      window.scrollTo({
        top: Math.max(0, targetY),
        behavior: 'smooth'
      });
    } else if (containerRef.current) {
      const totalScrollable = containerRef.current.offsetHeight - window.innerHeight;
      window.scrollTo({
        top: totalScrollable + 20,
        behavior: 'smooth'
      });
    }
  }, [containerRef]);

  const handleSelectItem = useCallback((item: string) => {
    setActiveItem(item);
    setMobileMenuOpen(false);

    if (item === 'STOCKPILOT') {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
      return;
    }

    if (item === 'PORTFOLIO') {
      scrollToSection('portfolio');
      return;
    }

    if (item === 'STRATEGY') {
      scrollToSection('strategy');
      return;
    }

    if (item === 'MARKETS' || item === 'MARKET') {
      scrollToSection('markets');
      return;
    }

    if (item === 'VERIFICATION') {
      scrollToSection('verification');
      return;
    }

    if (item === 'EXECUTION' || item === 'AGENT' || item === 'SIMULATION') {
      scrollToSection('execution');
      return;
    }

    if (item === 'STATUS') {
      setStatusModalOpen(true);
      return;
    }
  }, [scrollToSection]);

  const handleLaunch = useCallback(() => {
    scrollToSection('portfolio');
    if (wallet.status === 'DISCONNECTED') {
      setTimeout(() => {
        setWalletModalOpen(true);
      }, 500);
    }
  }, [scrollToSection, wallet.status]);

  // Active section tracking on scroll
  React.useEffect(() => {
    const handleScroll = () => {
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const heroHeight = containerRef.current?.offsetHeight ?? 0;
      const heroThreshold = Math.max(0, heroHeight - window.innerHeight);

      if (scrollTop < heroThreshold * 0.85) {
        setActiveItem('STOCKPILOT');
        return;
      }

      // Check section offsets from bottom to top
      const sectionMap: { id: string; name: string }[] = [
        { id: 'execution', name: 'EXECUTION' },
        { id: 'verification', name: 'VERIFICATION' },
        { id: 'markets', name: 'MARKETS' },
        { id: 'strategy', name: 'STRATEGY' },
        { id: 'portfolio', name: 'PORTFOLIO' }
      ];

      for (const section of sectionMap) {
        const el = document.getElementById(section.id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 220) {
            setActiveItem(section.name);
            break;
          }
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [containerRef]);

  return (
    <div className="relative min-h-screen bg-[#080D16] text-slate-100 selection:bg-cyan-500/20 selection:text-cyan-200">
      {/* Sticky Navbar at z-50 */}
      <Navbar
        scrollProgress={scrollProgress}
        onOpenMobileMenu={() => setMobileMenuOpen(true)}
        activeItem={activeItem}
        onSelectItem={handleSelectItem}
        onOpenStatus={() => setStatusModalOpen(true)}
        walletStatus={wallet.status}
        walletAddress={wallet.address}
        walletAbbreviatedAddress={wallet.abbreviatedAddress}
        isBscMainnet={wallet.isBscMainnet}
        onOpenWalletModal={() => setWalletModalOpen(true)}
        onDisconnectWallet={wallet.disconnectWallet}
      />

      {/* Fullscreen Mobile Menu Drawer */}
      <MobileMenu
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        activeItem={activeItem}
        onSelectItem={handleSelectItem}
        onOpenStatus={() => {
          setMobileMenuOpen(false);
          setStatusModalOpen(true);
        }}
        walletStatus={wallet.status}
        walletAbbreviatedAddress={wallet.abbreviatedAddress}
        onOpenWalletModal={() => setWalletModalOpen(true)}
      />

      {/* System Status Modal */}
      <StatusModal
        isOpen={statusModalOpen}
        onClose={() => setStatusModalOpen(false)}
      />

      {/* Wallet Connection Modal */}
      <WalletModal
        isOpen={walletModalOpen}
        onClose={() => setWalletModalOpen(false)}
        status={wallet.status}
        providerType={wallet.providerType}
        address={wallet.address}
        abbreviatedAddress={wallet.abbreviatedAddress}
        chainId={wallet.chainId}
        error={wallet.error}
        onConnectBinance={() => wallet.connectWallet('BINANCE')}
        onConnectInjected={() => wallet.connectWallet('INJECTED')}
        onDisconnect={wallet.disconnectWallet}
        onSwitchToBsc={wallet.switchToBsc}
      />

      {/* Main Experience */}
      <main>
        {/* Layers 1, 2, 3: Cinematic Hero Viewport (500vh Track) */}
        <CinematicHero
          containerRef={containerRef}
          videoRef={videoRef}
          canvasRef={canvasRef}
          scrollProgress={scrollProgress}
          canvasLive={canvasLive}
          videoSrc={VIDEO_URL}
          onLaunch={handleLaunch}
        />

        {/* Section 5 & 6: Institutional Command Center Dashboard */}
        <CommandCenter
          activeTab={activeItem}
          onSelectTab={(tab) => {
            setActiveItem(tab);
          }}
          onOpenStatusModal={() => setStatusModalOpen(true)}
          wallet={wallet}
          onOpenWalletModal={() => setWalletModalOpen(true)}
        />
      </main>
    </div>
  );
};

export default App;
