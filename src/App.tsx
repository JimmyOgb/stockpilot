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
  const [commandCenterTab, setCommandCenterTab] = useState<string>('PORTFOLIO');

  const wallet = useWallet();

  const {
    containerRef,
    videoRef,
    canvasRef,
    scrollProgress,
    canvasLive
  } = useVideoScrub({ videoSrc: VIDEO_URL });

  const scrollToCommandCenter = useCallback((tab?: string) => {
    if (tab) {
      setCommandCenterTab(tab);
    }
    const el = document.getElementById('command-center');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
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
      scrollToCommandCenter('PORTFOLIO');
      return;
    }

    if (item === 'STRATEGY') {
      scrollToCommandCenter('STRATEGY');
      return;
    }

    if (item === 'VERIFICATION') {
      scrollToCommandCenter('VERIFICATION');
      return;
    }

    if (item === 'EXECUTION' || item === 'AGENT') {
      scrollToCommandCenter('EXECUTION');
      return;
    }

    if (item === 'STATUS') {
      setStatusModalOpen(true);
      return;
    }
  }, [scrollToCommandCenter]);

  const handleLaunch = useCallback(() => {
    scrollToCommandCenter('PORTFOLIO');
    if (wallet.status === 'DISCONNECTED') {
      setTimeout(() => {
        setWalletModalOpen(true);
      }, 500);
    }
  }, [scrollToCommandCenter, wallet.status]);

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
          activeTab={commandCenterTab}
          onSelectTab={(tab) => {
            setCommandCenterTab(tab);
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
