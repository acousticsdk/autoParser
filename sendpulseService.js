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

    async createContact(phone) {
        try {
            const token = await this.getToken();
            const cleanPhone = phone.replace(/\D/g, '');

            const contactResponse = await axios.post(
                `${this.baseUrl}/crm/v1/contacts`,
                {
                    firstName: `Contact ${cleanPhone}`, // Добавляем обязательное поле firstName
                    channels: [{
                        type: 'phone',
                        value: cleanPhone
                    }]
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            return contactResponse.data.id;
        } catch (error) {
            console.error('Error creating contact:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async addDeal(phone, url, price, title) {
        try {
            const token = await this.getToken();
            
            // Очищаем номер телефона от всех нецифровых символов
            const cleanPhone = phone.replace(/\D/g, '');
            
            // Преобразуем цену в число
            const numericPrice = parseInt(price.replace(/\D/g, ''));
            
            // Сначала создаем контакт
            const contactId = await this.createContact(cleanPhone);
            
            // Создаем сделку с ценой и названием машины
            const dealResponse = await axios.post(
                `${this.baseUrl}/crm/v1/deals`,
                {
                    pipelineId: 130957,
                    stepId: 451337,
                    name: title,
                    price: numericPrice,
                    currency: 'USD',
                    attributes: [
                        {
                            attributeId: 780917,
                            value: cleanPhone
                        },
                        {
                            attributeId: 780918,
                            value: url
                        }
                    ],
                    contact: [contactId]
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`✓ Successfully added deal "${title}" with price ${numericPrice} USD for phone: ${phone}`);
            return true;
        } catch (error) {
            console.error('Error in SendPulse CRM operation:', error.response ? error.response.data : error);
            return false;
        }
    }
}