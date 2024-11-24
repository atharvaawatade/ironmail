// content.js
class EmailScanner {
    constructor() {
        this.initialized = false;
        this.EMAIL_SELECTORS = {
            gmail: [
                'div[role="dialog"] .a3s.aiL',         // Email body in popup
                'div[role="main"] .a3s.aiL',           // Email body in main view
                '.h7.ie.lr > .Ar.Au > div',            // Expanded email thread
                '.gs .ii.gt',                          // Alternative email structure
                'div[data-message-id] .a3s.aiL'        // Message-specific content
            ],
            outlook: [
                '#Item\\.MessageNormalizedBody',
                '#Item\\.MessageUniqueBody',
                '.ms-Fabric.elementToProof',
                '.Organization-Read_email-body'
            ]
        };
        this.initialize();
    }

    async initialize() {
        if (this.initialized) return;
        
        // Inject required styles for highlighting
        const style = document.createElement('style');
        style.textContent = `
            .iron-mail-highlight {
                background-color: rgba(255, 255, 0, 0.3);
                border: 1px solid #FFD700;
                border-radius: 2px;
                padding: 2px;
            }
        `;
        document.head.appendChild(style);
        
        // Set up message listeners
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === "triggerScan") {
                this.performScan().then(sendResponse);
                return true;
            }
        });

        this.initialized = true;
    }

    getEmailPlatform() {
        const hostname = window.location.hostname;
        if (hostname.includes('gmail')) return 'gmail';
        if (hostname.includes('outlook')) return 'outlook';
        return null;
    }

    async extractEmailMetadata() {
        const platform = this.getEmailPlatform();
        if (!platform) return null;

        let metadata = {
            subject: '',
            sender: '',
            recipients: [],
            date: '',
            attachments: []
        };

        try {
            if (platform === 'gmail') {
                metadata.subject = document.querySelector('h2.hP')?.textContent || '';
                metadata.sender = document.querySelector('.gD')?.getAttribute('email') || '';
                metadata.date = document.querySelector('.g3')?.textContent || '';
                
                // Get attachments
                const attachments = document.querySelectorAll('.aZo');
                metadata.attachments = Array.from(attachments).map(att => ({
                    name: att.getAttribute('data-tooltip') || 'Unknown attachment',
                    type: att.querySelector('img')?.getAttribute('alt') || 'unknown'
                }));
            } else if (platform === 'outlook') {
                metadata.subject = document.querySelector('[role="heading"]')?.textContent || '';
                metadata.sender = document.querySelector('.UxMIS')?.textContent || '';
                metadata.date = document.querySelector('._24pqs')?.textContent || '';
            }
        } catch (error) {
            console.error('Error extracting metadata:', error);
        }

        return metadata;
    }

    async extractEmailContent() {
        const platform = this.getEmailPlatform();
        if (!platform) {
            throw new Error('Unsupported email platform');
        }

        let content = '';
        const selectors = this.EMAIL_SELECTORS[platform];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                const text = element.innerText.trim();
                if (text && text.length > 50) {
                    content = text;
                    // Highlight the found content temporarily
                    element.classList.add('iron-mail-highlight');
                    setTimeout(() => element.classList.remove('iron-mail-highlight'), 2000);
                    break;
                }
            }
            if (content) break;
        }

        if (!content) {
            throw new Error('No email content found. Please make sure an email is open.');
        }

        return content;
    }

    async analyzePotentialThreats(content) {
        const threats = {
            suspicious_links: [],
            potential_phishing: false,
            suspicious_attachments: false,
            urgent_language: false
        };

        // Check for suspicious URLs
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = content.match(urlRegex) || [];
        threats.suspicious_links = urls.filter(url => {
            return url.includes('bit.ly') || 
                   url.includes('tinyurl') ||
                   url.includes('goo.gl');
        });

        // Check for phishing indicators
        const phishingKeywords = [
            'verify your account',
            'update your information',
            'click here immediately',
            'unusual activity',
            'account suspended'
        ];
        threats.potential_phishing = phishingKeywords.some(keyword => 
            content.toLowerCase().includes(keyword.toLowerCase())
        );

        // Check for urgent language
        const urgentKeywords = [
            'urgent',
            'immediate action',
            'account closure',
            'limited time',
            'act now'
        ];
        threats.urgent_language = urgentKeywords.some(keyword => 
            content.toLowerCase().includes(keyword.toLowerCase())
        );

        return threats;
    }

    async performScan() {
        try {
            // Update status: Starting scan
            chrome.runtime.sendMessage({
                action: "updateStatus",
                status: "Starting email analysis..."
            });

            // Extract content and metadata
            const content = await this.extractEmailContent();
            const metadata = await this.extractEmailMetadata();
            
            // Update status: Content extracted
            chrome.runtime.sendMessage({
                action: "updateStatus",
                status: "Processing email content..."
            });

            // Analyze for potential threats
            const threats = await this.analyzePotentialThreats(content);

            // Prepare the payload for the AI analysis
            const analysisPayload = {
                content: content,
                metadata: metadata,
                preliminary_analysis: threats
            };

            // Send to server for AI analysis
            const response = await fetch("http://localhost:8000/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(analysisPayload)
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const result = await response.json();

            // Combine local analysis with AI analysis
            const finalAnalysis = {
                ...result,
                local_threats: threats,
                metadata: metadata
            };

            // Send complete results
            chrome.runtime.sendMessage({
                action: "scanComplete",
                threatLevel: result.threatLevel,
                analysis: result.analysis,
                details: finalAnalysis
            });

            return finalAnalysis;

        } catch (error) {
            console.error("Scan error:", error);
            chrome.runtime.sendMessage({
                action: "scanComplete",
                threatLevel: "error",
                analysis: error.message
            });
            return null;
        }
    }
}

// Initialize the scanner
const scanner = new EmailScanner();