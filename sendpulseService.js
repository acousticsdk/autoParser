import axios from 'axios';

export class SendPulseService {
    constructor() {
        this.clientId = process.env.SENDPULSE_CLIENT_ID;
        this.clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
        this.baseUrl = 'https://api.sendpulse.com';
        this.token = null;
        this.tokenExpires = null;
    }

    async getToken(forceRefresh = false) {
        // Если токен есть и не истек, возвращаем его
        if (!forceRefresh && this.token && this.tokenExpires && Date.now() < this.tokenExpires - 60000) {
            return this.token;
        }

        try {
            console.log('Getting new SendPulse token...');
            const response = await axios.post(`${this.baseUrl}/oauth/access_token`, {
                grant_type: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret
            });

            this.token = response.data.access_token;
            // Устанавливаем время истечения на минуту раньше реального для подстраховки
            this.tokenExpires = Date.now() + ((response.data.expires_in - 60) * 1000);
            console.log('New SendPulse token received');
            return this.token;
        } catch (error) {
            console.error('Error getting SendPulse token:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async makeRequest(method, endpoint, data = null) {
        const maxRetries = 2;
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const token = await this.getToken(attempt > 0);
                
                const config = {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                };

                const url = `${this.baseUrl}${endpoint}`;
                
                if (method === 'GET') {
                    const response = await axios.get(url, config);
                    return response.data;
                } else if (method === 'POST') {
                    const response = await axios.post(url, data, config);
                    return response.data;
                }
            } catch (error) {
                lastError = error;
                
                // Если ошибка 401 (истекший токен), пробуем получить новый токен
                if (error.response && error.response.status === 401) {
                    console.log('Token expired, will retry with new token...');
                    if (attempt < maxRetries) {
                        continue;
                    }
                }
                
                throw error;
            }
        }

        throw lastError;
    }

    formatPhoneNumber(phone) {
        // Удаляем все нецифровые символы
        const cleanPhone = phone.replace(/\D/g, '');
        
        // Убираем префикс 380 если он есть
        const normalizedPhone = cleanPhone.replace(/^380/, '');
        
        // Добавляем 380 без плюса для phones массива
        return '380' + normalizedPhone;
    }

    async createContact(phoneNumber, name) {
        try {
            const formattedPhone = this.formatPhoneNumber(phoneNumber);
            
            const contactData = {
                responsibleId: 8300068,
                firstName: name.trim(),
                phones: [formattedPhone]
            };

            const response = await this.makeRequest('POST', '/crm/v1/contacts', contactData);
            
            if (response.success && response.data && response.data.id) {
                return response.data.id;
            }
            
            throw new Error('Failed to create contact: Invalid response format');
        } catch (error) {
            console.error('Error creating contact:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async linkContactToDeal(dealId, contactId) {
        try {
            await this.makeRequest('POST', `/crm/v1/deals/${dealId}/contacts/${contactId}`);
            return true;
        } catch (error) {
            console.error('Error linking contact to deal:', error.response ? error.response.data : error);
            return false;
        }
    }

    async addDeal(phone, url, price, title, sellerName = 'Клієнт') {
        try {
            if (!phone || phone === 'Телефон на сайті') {
                console.log('Invalid phone number, skipping SendPulse');
                return false;
            }

            console.log(`Creating SendPulse deal for ${phone} (${title})`);
            
            // Форматируем телефон с плюсом для binotel_phone
            const formattedBinotelPhone = '+' + this.formatPhoneNumber(phone);
            
            // Преобразуем цену в число
            const numericPrice = parseInt(price.replace(/\D/g, ''));
            
            // Создаем сделку с ценой и названием машины
            const dealData = {
                pipelineId: 130957,
                stepId: 451337,
                name: title,
                price: numericPrice,
                currency: 'USD',
                attributes: [
                    {
                        attributeId: 780917,
                        value: formattedBinotelPhone
                    },
                    {
                        attributeId: 780918,
                        value: url
                    }
                ]
            };

            // Создаем сделку
            const dealResponse = await this.makeRequest('POST', '/crm/v1/deals', dealData);
            
            if (!dealResponse || !dealResponse.data || !dealResponse.data.id) {
                throw new Error('Failed to create deal: Invalid response format');
            }
            
            const dealId = dealResponse.data.id;
            
            // Создаем контакт
            const contactId = await this.createContact(phone, sellerName);
            
            // Связываем контакт со сделкой
            await this.linkContactToDeal(dealId, contactId);

            console.log(`✓ Successfully added deal "${title}" with price ${numericPrice} USD for phone: ${formattedBinotelPhone}`);
            return true;
        } catch (error) {
            console.error('Error in SendPulse CRM operation:', error.response ? error.response.data : error);
            return false;
        }
    }
}