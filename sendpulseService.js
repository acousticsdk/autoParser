import axios from 'axios';

export class SendPulseService {
    constructor() {
        this.clientId = process.env.SENDPULSE_CLIENT_ID;
        this.clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
        this.baseUrl = 'https://api.sendpulse.com';
        this.token = null;
        this.tokenExpires = null;
    }

    async getToken() {
        if (this.token && this.tokenExpires && Date.now() < this.tokenExpires) {
            return this.token;
        }

        try {
            const response = await axios.post(`${this.baseUrl}/oauth/access_token`, {
                grant_type: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret
            });

            this.token = response.data.access_token;
            this.tokenExpires = Date.now() + (response.data.expires_in * 1000);
            return this.token;
        } catch (error) {
            console.error('Error getting SendPulse token:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async addDeal(phone, url) {
        try {
            const token = await this.getToken();
            
            // Очищаем номер телефона от всех нецифровых символов
            const cleanPhone = phone.replace(/\D/g, '');
            
            // Генерируем случайный ID для контакта (5-значное число)
            const contactId = Math.floor(10000 + Math.random() * 90000);
            
            const response = await axios.post(
                `${this.baseUrl}/crm/v1/deals`,
                {
                    pipelineId: 130957,
                    stepId: 451337,
                    name: `Лид с сайта: ${phone}`,
                    contact: {
                        name: contactId, // Используем числовой ID вместо строки
                        phone: parseInt(cleanPhone) // Преобразуем строку в число
                    },
                    customFields: {
                        website_url: url
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`✓ Successfully added deal: ${phone}`);
            return true;
        } catch (error) {
            console.error('Error adding deal to SendPulse CRM:', error.response ? error.response.data : error);
            return false;
        }
    }
}